import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

const dynamodb = new DynamoDBClient({ region: "ap-northeast-1" });
const bedrock = new BedrockRuntimeClient({ region: "us-west-2" });

async function getChatHistory(sessionId) {
    const params = {
        TableName: "ChatLogTable",
        KeyConditionExpression: "sessionId = :sessionId",
        ExpressionAttributeValues: marshall({
            ":sessionId": sessionId
        }),
        ScanIndexForward: true
    };
    
    const result = await dynamodb.send(new QueryCommand(params));
    return result.Items.map(item => unmarshall(item));
}

async function chatWithClaude(messages) {
    try {
        const input = {
            modelId: "us.anthropic.claude-3-sonnet-20240229-v1:0",
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 1000,
                messages: messages,
                temperature: 0.7
            })
        };

        const command = new InvokeModelCommand(input);
        const response = await bedrock.send(command);
        const responseData = JSON.parse(new TextDecoder().decode(response.body));
        
        // AI 응답에 분석 형식 추가
        let aiResponse = responseData.content[0].text;
        if (!aiResponse.includes('### ANALYSIS ###')) {
            aiResponse += `\n\n### ANALYSIS ###\n{
    "phase": "탐색",
    "interests": ["파악된 관심사"],
    "strengths": ["파악된 강점"],
    "development_needs": ["발전 필요 영역"],
    "career_paths": ["추천 진로"],
    "action_items": ["다음 단계"],
    "next_discussion": ["다음 주제"]
}`;
        }
        
        return aiResponse;
    } catch (error) {
        console.error('Error calling Bedrock:', error);
        throw error;
    }
}

async function saveAnalysis(sessionId, userId, analysis) {
    try {
        const parsedAnalysis = JSON.parse(analysis);
        const analysisParams = {
            TableName: "CareerAnalysisTable",
            Item: marshall({
                sessionId,
                timestamp: Date.now(),
                userId,
                ...parsedAnalysis,
                type: 'career_analysis'
            })
        };
        
        await dynamodb.send(new PutItemCommand(analysisParams));
        console.log('Analysis saved successfully');
    } catch (error) {
        console.error('Error saving analysis:', error);
    }
}

export const handler = async (event) => {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    if (!event.requestContext || !event.body) {
        throw new Error('Invalid event structure');
    }
    
    const { connectionId, domainName, stage } = event.requestContext;

    try {
        const body = JSON.parse(event.body);
        if (!body.sessionId || !body.userId || !body.message) {
            throw new Error('Missing required fields in request body');
        }

        // 사용자 메시지 저장
        await dynamodb.send(new PutItemCommand({
            TableName: "ChatLogTable",
            Item: marshall({
                sessionId: body.sessionId,
                timestamp: Date.now(),
                userId: body.userId,
                message: body.message,
                sender: 'user',
                isComplete: false
            })
        }));
        
        // 채팅 히스토리 조회
        const chatHistory = await getChatHistory(body.sessionId);
        const messages = chatHistory.map(chat => ({
            role: chat.sender === 'user' ? 'user' : 'assistant',
            content: chat.message
        }));
        
        // AI 응답 요청
        const aiResponse = await chatWithClaude(messages);
        
        // 분석 정보 추출 및 저장
        const analysisMatch = aiResponse.match(/### ANALYSIS ###\n([\s\S]+)$/);
        let cleanResponse = aiResponse;
        
        if (analysisMatch) {
            cleanResponse = aiResponse.replace(/### ANALYSIS ###\n[\s\S]+$/, '').trim();
            await saveAnalysis(body.sessionId, body.userId, analysisMatch[1]);
        }
        
        // AI 응답 저장
        await dynamodb.send(new PutItemCommand({
            TableName: "ChatLogTable",
            Item: marshall({
                sessionId: body.sessionId,
                timestamp: Date.now(),
                userId: body.userId,
                message: cleanResponse,
                sender: 'ai',
                isComplete: true
            })
        }));
        
        // WebSocket 응답
        const wsEndpoint = `https://${domainName}/${stage}`;
        const callbackAPI = new ApiGatewayManagementApiClient({
            endpoint: wsEndpoint,
            region: "ap-northeast-1"
        });

        await callbackAPI.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: JSON.stringify({
                message: cleanResponse,
                sender: 'ai',
                timestamp: Date.now()
            })
        }));
        
        return { statusCode: 200 };
        
    } catch (error) {
        console.error('Error details:', error);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ 
                error: 'Error processing message',
                details: error.message,
                name: error.name
            }) 
        };
    }
};
