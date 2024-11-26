import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const {
    CONNECTION_TABLE_NAME
} = process.env;

// 필수 환경변수 체크
if (!CONNECTION_TABLE_NAME) {
    throw new Error('Required environment variables are missing');
}

const dynamodb = new DynamoDBClient({ region: "ap-northeast-1" });

export const handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    
    try {
        const params = {
            TableName: CONNECTION_TABLE_NAME,
            Key: marshall({
                connectionId: connectionId
            })
        };
        
        await dynamodb.send(new DeleteItemCommand(params));
        
        return {
            statusCode: 200,
            body: 'Disconnected'
        };
    } catch (err) {
        console.error('Error disconnecting:', err);
        return {
            statusCode: 500,
            body: 'Failed to disconnect: ' + err
        };
    }
};