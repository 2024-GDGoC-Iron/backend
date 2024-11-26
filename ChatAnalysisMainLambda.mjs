import { S3, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Lambda, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const {
    BUCKET_NAME,
    ANALYZE_LAMBDA_NAME,
    MATCH_LAMBDA_NAME,
    PROFESSORS_TABLE_NAME,
    RESULTS_TABLE_NAME
} = process.env;

// 필수 환경변수 체크
if (!BUCKET_NAME || !ANALYZE_LAMBDA_NAME || !MATCH_LAMBDA_NAME || !PROFESSORS_TABLE_NAME || !RESULTS_TABLE_NAME) {
    throw new Error('Required environment variables are missing');
}

const s3Client = new S3();
const lambdaClient = new Lambda();
const ddbClient = DynamoDBDocument.from(new DynamoDB());

const invokeLambda = async (functionName, payload) => {
  console.log(`Invoking ${functionName} with payload:`, JSON.stringify(payload));
  
  const result = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(payload)
    })
  );

  const response = JSON.parse(Buffer.from(result.Payload).toString());
  console.log(`${functionName} response:`, JSON.stringify(response));

  if (response.statusCode !== 200) {
    throw new Error(`${functionName} failed: ${JSON.parse(response.body).message}`);
  }

  return JSON.parse(response.body);
};

const getProfessorDetails = async (professorId) => {
  const { Item } = await ddbClient.send(
    new GetCommand({
      TableName: PROFESSORS_TABLE_NAME,
      Key: { professorId }
    })
  );
  
  if (!Item) {
    throw new Error(`Professor not found: ${professorId}`);
  }
  
  return Item;
};

export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event));

  try {
    const { sessionId } = event.body ? JSON.parse(event.body) : event;

    if (!sessionId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'sessionId is required' })
      };
    }

    // 1. 채팅 내용 가져오기
    let chatHistory;
    try {
      const chatData = await s3Client.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `chats/${sessionId}.json`
        })
      );
      chatHistory = JSON.parse(await chatData.Body.transformToString());
      console.log('Chat history loaded:', JSON.stringify(chatHistory));
    } catch (error) {
      console.error('Error loading chat history:', error);
      throw new Error('Failed to load chat history');
    }

    // 2. 고민 내용 분석
    const analysis = await invokeLambda(ANALYZE_LAMBDA_NAME, { sessionId });
    console.log('Analysis result:', JSON.stringify(analysis));

    // 3. 교수 매칭
    const match = await invokeLambda(MATCH_LAMBDA_NAME, { analysis });
    console.log('Match result:', JSON.stringify(match));

    // 4. 교수 정보 가져오기
    if (match?.matchedProfessor?.professorId) {
      const { Item: professorDetails } = await ddbClient.send(
        new GetCommand({
          TableName: PROFESSORS_TABLE_NAME,
          Key: { professorId: match.matchedProfessor.professorId }
        })
      );

      if (professorDetails) {
        match.matchedProfessor = {
          ...match.matchedProfessor,
          ...professorDetails
        };
      }
    }

    // 5. 전체 결과 저장
    const finalResult = {
      sessionId,
      timestamp: new Date().toISOString(),
      analysis,
      match
    };

    await Promise.all([
      s3Client.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: `results/${sessionId}.json`,
          Body: JSON.stringify(finalResult)
        })
      ),
      ddbClient.send(
        new PutCommand({
          TableName: RESULTS_TABLE_NAME,
          Item: {
            sessionId,
            timestamp: new Date().toISOString(),
            ...finalResult,
            ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60)
          }
        })
      )
    ]);

    return {
      statusCode: 200,
      body: JSON.stringify(finalResult)
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: error.name || 'Error',
        message: error.message || 'An unexpected error occurred'
      })
    };
  }
};