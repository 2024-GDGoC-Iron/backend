import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const s3 = new S3Client({ region: "ap-northeast-1" });
const bedrock = new BedrockRuntimeClient({ region: "us-west-2" });

const BUCKET_NAME = "inpick-chat-bucket";

const SYSTEM_PROMPT = `당신은 학생들의 진로 상담을 통해 교수님께 전달할 분석 데이터를 수집하는 상담가입니다. 
다음 단계에 따라 대화를 진행하세요. 각 단계에서 확인되지 않은 정보는 수집하기 위해 재질문하세요:

1단계 - 학업 현황 파악
- 현재 학년/전공
- 학점 및 주요 과목 이수 현황
- 관심있는 세부 전공 분야

2단계 - 진로 희망 사항
- 목표로 하는 진로 분야
- 대학원 진학 vs 취업 선호도
- 관심있는 기업/연구실

3단계 - 준비 상황
- 보유한 기술/자격증
- 프로젝트 경험
- 어학 능력

4단계 - 고민 사항
- 현재 겪는 어려움
- 진로 선택시 우선순위
- 조언이 필요한 부분

응답 요구사항:
1. 한 번에 하나의 정보만 물어보세요
2. 이미 파악한 정보는 다시 묻지 마세요
3. 답변에 공감하고 구체적으로 조언해주세요
4. 각 단계가 완료되면 다음 단계로 자연스럽게 넘어가세요

물어볼게 없다고 할 경우:
1. 지금까지의 상담 내용을 다음 형식으로 깔끔하게 요약하세요:
   - 기본 정보 (학년/전공/학점)
   - 희망 진로 (목표/관심분야)
   - 보유 역량 (기술/자격증/경험)
   - 고민 사항
   - 종합 의견
2. 요약 후 "상담이 도움이 되셨길 바랍니다. 추후 교수님과의 상담에 이 내용이 활용될 예정입니다."로 마무리하세요`;

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
            modelId: "us.anthropic.claude-3-sonnet-20240229-v1:0",
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
        
        // message 객체 검증 추가
        if (!body || typeof body !== 'object') {
            throw new Error('Invalid message format');
        }

        // message 객체 안의 데이터 추출
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

        // 1. 채팅 이력 가져오기
        const chatHistory = await getChatHistory(sessionId);

        // 2. 사용자 메시지 추가
        chatHistory.messages.push({
            type: 'user',
            content: message,
            timestamp: Date.now()
        });
       
        // 3. AI 응답 생성
        const aiResponse = await chatWithClaude(message, chatHistory);

        // 4. AI 응답 추가
        chatHistory.messages.push({
            type: 'ai',
            content: aiResponse,
            timestamp: Date.now()
        });

        // 5. 채팅 이력 저장
        await updateChatHistory(sessionId, chatHistory);
        
        // 6. WebSocket 응답 전송
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
