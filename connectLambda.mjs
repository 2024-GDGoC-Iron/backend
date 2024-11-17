import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const dynamodb = new DynamoDBClient({ region: "ap-northeast-1" });

export const handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const timestamp = Date.now();
    
    try {
        const params = {
            TableName: "ConnectionTable",
            Item: marshall({
                connectionId: connectionId,
                timestamp: timestamp,
                userId: event.queryStringParameters?.userId || 'anonymous',
                sessionId: event.queryStringParameters?.sessionId || `session_${timestamp}`
            })
        };
        
        await dynamodb.send(new PutItemCommand(params));
        
        return {
            statusCode: 200,
            body: 'Connected'
        };
    } catch (err) {
        console.error('Error connecting:', err);
        return {
            statusCode: 500,
            body: 'Failed to connect: ' + err
        };
    }
};
