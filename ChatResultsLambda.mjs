import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

const {
    RESULTS_TABLE_NAME
} = process.env;

// 필수 환경변수 체크
if (!RESULTS_TABLE_NAME) {
    throw new Error('Required environment variables are missing');
}

const ddbClient = DynamoDBDocument.from(new DynamoDB({ 
  region: 'ap-northeast-1',
  maxRetries: 3,
  httpOptions: {
    timeout: 5000
  }
}));

// 개선된 DynamoDB 데이터 포맷팅 함수
const formatDynamoDBItem = (item) => {
  if (!item) return null;

  const unwrapValue = (val) => {
    if (!val) return null;
    if (typeof val === 'object') {
      if ('S' in val) return val.S;
      if ('N' in val) return Number(val.N);
      if ('L' in val) return val.L.map(unwrapValue);
      if ('M' in val) return Object.entries(val.M).reduce((acc, [key, value]) => {
        acc[key] = unwrapValue(value);
        return acc;
      }, {});
      return Object.entries(val).reduce((acc, [key, value]) => {
        acc[key] = unwrapValue(value);
        return acc;
      }, {});
    }
    return val;
  };

  try {
    const formattedItem = {
      sessionId: unwrapValue(item.sessionId),
      timestamp: unwrapValue(item.timestamp),
      analysis: {
        studentProfile: {
          year: unwrapValue(item.analysis?.M?.studentProfile?.M?.year || item.analysis?.studentProfile?.year),
          major: unwrapValue(item.analysis?.M?.studentProfile?.M?.major || item.analysis?.studentProfile?.major),
          gpa: unwrapValue(item.analysis?.M?.studentProfile?.M?.gpa || item.analysis?.studentProfile?.gpa),
          interests: unwrapValue(item.analysis?.M?.studentProfile?.M?.interests?.L || 
                               item.analysis?.studentProfile?.interests || [])
        },
        careerGoals: {
          pathType: unwrapValue(item.analysis?.M?.careerGoals?.M?.pathType || 
                               item.analysis?.careerGoals?.pathType),
          targetField: unwrapValue(item.analysis?.M?.careerGoals?.M?.targetField || 
                                 item.analysis?.careerGoals?.targetField),
          preparation: unwrapValue(item.analysis?.M?.careerGoals?.M?.preparation?.L || 
                                 item.analysis?.careerGoals?.preparation || [])
        },
        consultingNeeds: {
          mainPurpose: unwrapValue(item.analysis?.M?.consultingNeeds?.M?.mainPurpose || 
                                 item.analysis?.consultingNeeds?.mainPurpose),
          specificQuestions: unwrapValue(item.analysis?.M?.consultingNeeds?.M?.specificQuestions?.L || 
                                       item.analysis?.consultingNeeds?.specificQuestions || [])
        }
      }
    };

    if (item.match?.M || item.match) {
      const matchData = item.match?.M || item.match;
      formattedItem.match = {
        match: {
          professor: {
            professorId: unwrapValue(matchData.match?.M?.professor?.M?.professorId || 
                                   matchData.match?.professor?.professorId),
            name: unwrapValue(matchData.match?.M?.professor?.M?.name || 
                            matchData.match?.professor?.name),
            department: unwrapValue(matchData.match?.M?.professor?.M?.department || 
                                  matchData.match?.professor?.department),
            position: unwrapValue(matchData.match?.M?.professor?.M?.position || 
                                matchData.match?.professor?.position),
            email: unwrapValue(matchData.match?.M?.professor?.M?.email || 
                             matchData.match?.professor?.email),
            location: unwrapValue(matchData.match?.M?.professor?.M?.location || 
                                matchData.match?.professor?.location),
            researchAreas: unwrapValue(matchData.match?.M?.professor?.M?.researchAreas || 
                                     matchData.match?.professor?.researchAreas),
            availableSlots: unwrapValue(matchData.match?.M?.professor?.M?.availableSlots || 
                                      matchData.match?.professor?.availableSlots),
            matchScore: unwrapValue(matchData.match?.M?.professor?.M?.matchScore || 
                                  matchData.match?.professor?.matchScore)
          },
          matchReason: unwrapValue(matchData.match?.M?.matchReason || 
                                 matchData.match?.matchReason),
          nextSteps: unwrapValue(matchData.match?.M?.nextSteps || 
                               matchData.match?.nextSteps)
        }
      };
    }

    return formattedItem;
  } catch (error) {
    console.error('Error formatting item:', error);
    console.error('Problematic item:', JSON.stringify(item));
    return null;
  }
};

export const handler = async (event) => {
  console.log('Received event:', JSON.stringify(event));

  try {
    const cutoffTime = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
    
    console.log('Scanning DynamoDB table...');
    const { Items } = await ddbClient.scan({
      TableName: RESULTS_TABLE_NAME,
      FilterExpression: '#t > :cutoff',
      ExpressionAttributeNames: {
        '#t': 'ttl'
      },
      ExpressionAttributeValues: {
        ':cutoff': cutoffTime
      }
    });

    if (!Items || Items.length === 0) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        },
        body: JSON.stringify([])
      };
    }

    const formattedItems = Items.map(item => {
      const formatted = formatDynamoDBItem(item);
      console.log('Formatted item:', JSON.stringify(formatted));
      return formatted;
    }).filter(Boolean)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify(formattedItems)
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({ 
        error: error.name || 'Error',
        message: error.message || 'An unexpected error occurred'
      })
    };
  }
};