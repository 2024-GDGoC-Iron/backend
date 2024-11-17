import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const dynamodb = new DynamoDBClient({ region: "ap-northeast-1" });

export const handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    
    try {
        const params = {
            TableName: "ConnectionTable",
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
