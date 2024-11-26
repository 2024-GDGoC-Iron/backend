import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const {
    BUCKET_NAME,
    BEDROCK_MODEL_ID
} = process.env;

// 필수 환경변수 체크
if (!BUCKET_NAME || !BEDROCK_MODEL_ID) {
    throw new Error('Required environment variables are missing');
}

const s3 = new S3Client({ region: "ap-northeast-1" });
const bedrock = new BedrockRuntimeClient({ region: "us-west-2" });

const SYSTEM_PROMPT = `당신은 효율적이고 친근한 대학 진로상담 상담가 인픽입니다. 
학생들의 핵심 정보를 빠르게 파악하여 적절한 교수님과 매칭하는 것이 목적입니다.

다음 정보를 자연스러운 대화로 수집하세요:

1. 기본 정보 (필수)
- 학년/전공
- 현재 평점
- 관심 분야와 이유

2. 진로 방향 (필수)
- 희망 진로 (취업/대학원/창업)
- 목표 직무/연구 분야
- 준비 현황 (프로젝트/자격증/경험)

3. 상담 목적 (필수)
- 교수님께 조언받고 싶은 구체적인 내용
- 현재 겪고 있는 어려움이나 고민

대화 지침:
1. 한 번에 하나의 질문만 하세요
2. 불필요한 세부사항은 묻지 마세요
3. 핵심 정보가 파악되면 바로 다음으로 넘어가세요
4. 공감하고 격려하는 톤을 유지하세요
5. 사용자가 읽기 편하게 줄바꿈을 잘 활용하세요`;

async function getChatHistory(sessionId) {
    try {
        const response = await s3.send(new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `chats/${sessionId}.json`
        }));
        
        const chatData = await response.Body.transformToString();
        return JSON.parse(chatData);
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            const newChatSession = {
                sessionId,
                messages: []
            };
            
            await updateChatHistory(sessionId, newChatSession);
            return newChatSession;
        }
        throw error;
    }
}

async function updateChatHistory(sessionId, chatData) {
    await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `chats/${sessionId}.json`,
        Body: JSON.stringify(chatData, null, 2),
        ContentType: 'application/json'
    }));
}

async function chatWithClaude(message, chatHistory) {
    try {
        const input = {
            modelId: BEDROCK_MODEL_ID,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 1000,
                messages: [
                    {
                        role: 'user',
                        content: `${SYSTEM_PROMPT}\n\n이전 대화:\n${JSON.stringify(chatHistory.messages)}\n\n사용자 메시지: ${message}`
                    }
                ],
                temperature: 0.7
            })
        };

        const command = new InvokeModelCommand(input);
        const response = await bedrock.send(command);
        const responseData = JSON.parse(new TextDecoder().decode(response.body));
        return responseData.content[0].text;
    } catch (error) {
        console.error('Error calling Bedrock:', error);
        throw error;
    }
}

export const handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    if (!event.requestContext || !event.body) {
        console.error('Invalid event structure:', event);
        throw new Error('Invalid event structure');
    }
    
    const { connectionId, domainName, stage } = event.requestContext;

    try {
        const body = JSON.parse(event.body);
        console.log('Parsed body:', body);
        
        if (!body || typeof body !== 'object') {
            throw new Error('Invalid message format');
        }

        const sessionId = body.sessionId || body.message?.sessionId;
        const userId = body.userId || body.message?.userId;
        const message = body.message?.message || body.content || body.text;
        const action = body.action || body.message?.action;

        console.log('Extracted data:', { sessionId, userId, message, action });

        if (!action || action !== 'sendMessage') {
            console.error('Invalid action:', action);
            throw new Error('Invalid action');
        }

        if (!sessionId || !userId || !message) {
            console.error('Missing fields. Required: sessionId, userId, message', { sessionId, userId, message });
            throw new Error('Missing required fields');
        }

        const chatHistory = await getChatHistory(sessionId);

        chatHistory.messages.push({
            type: 'user',
            content: message,
            timestamp: Date.now()
        });
       
        const aiResponse = await chatWithClaude(message, chatHistory);

        chatHistory.messages.push({
            type: 'ai',
            content: aiResponse,
            timestamp: Date.now()
        });

        await updateChatHistory(sessionId, chatHistory);
        
        const wsEndpoint = `https://${domainName}/${stage}`;
        const callbackAPI = new ApiGatewayManagementApiClient({
            endpoint: wsEndpoint,
            region: "ap-northeast-1"
        });

        await callbackAPI.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({
                type: 'message',
                data: {
                    message: aiResponse,
                    sender: 'ai',
                    timestamp: Date.now()
                }
            })
        }));

        return { 
            statusCode: 200,
            body: JSON.stringify({ success: true }) 
        };
        
    } catch (error) {
        console.error('Error details:', error);
        
        if (event.requestContext) {
            try {
                const callbackAPI = new ApiGatewayManagementApiClient({
                    endpoint: `https://${domainName}/${stage}`,
                    region: "ap-northeast-1"
                });

                await callbackAPI.send(new PostToConnectionCommand({
                    ConnectionId: connectionId,
                    Data: JSON.stringify({
                        type: 'error',
                        data: {
                            message: '오류가 발생했습니다.',
                            timestamp: Date.now()
                        }
                    })
                }));
            } catch (wsError) {
                console.error('Error sending error message:', wsError);
            }
        }
        
        return { 
            statusCode: 500, 
            body: JSON.stringify({ 
                error: 'Error processing message',
                details: error.message
            }) 
        };
    }
};