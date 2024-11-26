import { S3 } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

// 필수 환경변수 설정
const {
    BUCKET_NAME,
    BEDROCK_MODEL_ID
} = process.env;

// 필수 환경변수 체크
if (!BUCKET_NAME || !BEDROCK_MODEL_ID) {
    throw new Error('Required environment variables are missing');
}

const s3Client = new S3({ region: 'us-west-2' });
const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });

const getChatFile = async (sessionId) => {
   try {
       const fileResponse = await s3Client.getObject({
           Bucket: BUCKET_NAME,
           Key: `chats/${sessionId}.json`
       });

       const bodyContents = await fileResponse.Body.transformToString();
       return JSON.parse(bodyContents);
   } catch (error) {
       console.error('Error fetching chat:', error);
       throw new Error('Failed to fetch chat data');
   }
};

const defaultResponse = {
   "studentProfile": {
       "year": null,
       "major": null,
       "gpa": null,
       "interests": []
   },
   "careerGoals": {
       "pathType": null,
       "targetField": null,
       "preparation": []
   },
   "consultingNeeds": {
       "mainPurpose": null,
       "specificQuestions": [],
       "currentChallenges": []
   },
   "recommendedFocus": {
       "strengths": [],
       "areasToImprove": [],
       "nextSteps": []
   }
};

const validateAndCleanData = (data, template) => {
   const result = {...template};
   
   try {
       if (data.studentProfile) {
           result.studentProfile = {
               year: Number(data.studentProfile.year) || null,
               major: String(data.studentProfile.major || ''),
               gpa: Number(data.studentProfile.gpa) || null,
               interests: Array.isArray(data.studentProfile.interests) 
                   ? data.studentProfile.interests.map(String)
                   : []
           };
       }
       
       if (data.careerGoals) {
           result.careerGoals = {
               pathType: String(data.careerGoals.pathType || ''),
               targetField: String(data.careerGoals.targetField || ''),
               preparation: Array.isArray(data.careerGoals.preparation)
                   ? data.careerGoals.preparation.map(String)
                   : []
           };
       }
       
       if (data.consultingNeeds) {
           result.consultingNeeds = {
               mainPurpose: String(data.consultingNeeds.mainPurpose || ''),
               specificQuestions: Array.isArray(data.consultingNeeds.specificQuestions)
                   ? data.consultingNeeds.specificQuestions.map(String)
                   : [],
               currentChallenges: Array.isArray(data.consultingNeeds.currentChallenges)
                   ? data.consultingNeeds.currentChallenges.map(String)
                   : []
           };
       }
       
       if (data.recommendedFocus) {
           result.recommendedFocus = {
               strengths: Array.isArray(data.recommendedFocus.strengths)
                   ? data.recommendedFocus.strengths.map(String)
                   : [],
               areasToImprove: Array.isArray(data.recommendedFocus.areasToImprove)
                   ? data.recommendedFocus.areasToImprove.map(String)
                   : [],
               nextSteps: Array.isArray(data.recommendedFocus.nextSteps)
                   ? data.recommendedFocus.nextSteps.map(String)
                   : []
           };
       }

       return result;
   } catch (error) {
       console.error('Validation error:', error);
       return template;
   }
};

const analyzeChatContent = async (messages) => {
   try {
       const chatText = messages
           .map(msg => `${msg.type}: ${msg.content}`)
           .join('\n');

       console.log('Analyzing chat text:', chatText);

       const improvedPrompt = `다음 대화를 분석하여 정확한 JSON 형식으로만 응답하세요. 설명이나 다른 텍스트를 절대 포함하지 마세요.

시스템: 당신은 학생 상담 분석 전문가입니다. 대화 내용에서 학생의 프로필, 진로 목표, 상담 니즈를 정확히 파악해야 합니다.

분석할 대화:
${chatText}

다음 형식의 JSON으로만 응답하세요:
${JSON.stringify(defaultResponse, null, 2)}

응답 규칙:
1. 반드시 위 JSON 구조를 그대로 따를 것
2. 모든 필드는 null이나 빈 배열이라도 포함할 것
3. 추가 설명이나 마크다운 없이 순수 JSON만 응답할 것
4. 숫자는 number 타입으로, 문자는 string 타입으로 응답할 것`;

       const command = new InvokeModelCommand({
           modelId: BEDROCK_MODEL_ID,
           contentType: "application/json",
           accept: "application/json",
           body: JSON.stringify({
               anthropic_version: "bedrock-2023-05-31",
               max_tokens: 2000,
               temperature: 0.1,
               messages: [{
                   role: "user",
                   content: improvedPrompt
               }]
           })
       });

       const response = await bedrockClient.send(command);
       const parsed = JSON.parse(new TextDecoder().decode(response.body));
       
       console.log('Raw Bedrock response:', parsed.content[0].text);
       
       let analysisResult;
       try {
           analysisResult = JSON.parse(parsed.content[0].text.trim());
       } catch (firstError) {
           console.log('Direct parsing failed, trying regex extraction...');
           try {
               const jsonMatch = parsed.content[0].text.match(/\{[\s\S]*\}/);
               if (jsonMatch) {
                   const cleanContent = jsonMatch[0]
                       .replace(/```json\n?|\n?```/g, '')
                       .replace(/[\u201C\u201D]/g, '"')
                       .replace(/'/g, '"')
                       .trim();
                   analysisResult = JSON.parse(cleanContent);
               } else {
                   console.error('No JSON pattern found in response');
                   return defaultResponse;
               }
           } catch (secondError) {
               console.error('All parsing attempts failed:', secondError);
               return defaultResponse;
           }
       }

       console.log('Parsed analysis result:', analysisResult);

       const validatedResult = validateAndCleanData(analysisResult, defaultResponse);
       console.log('Validated result:', validatedResult);
       
       return validatedResult;

   } catch (error) {
       console.error('Analysis error:', error);
       return defaultResponse;
   }
};

export const handler = async (event) => {
   console.log('Received event:', JSON.stringify(event));

   try {
       const { sessionId } = event;
       if (!sessionId) {
           throw new Error('sessionId is required');
       }

       const chatHistory = await getChatFile(sessionId);
       
       if (!chatHistory.messages || !Array.isArray(chatHistory.messages)) {
           throw new Error('Invalid chat history format');
       }

       const analysis = await analyzeChatContent(chatHistory.messages);

       return {
           statusCode: 200,
           headers: {
               'Content-Type': 'application/json',
               'Access-Control-Allow-Origin': '*',
               'Access-Control-Allow-Methods': 'POST, OPTIONS',
               'Access-Control-Allow-Headers': 'Content-Type'
           },
           body: JSON.stringify(analysis)
       };
   } catch (error) {
       console.error('Handler error:', error);
       return {
           statusCode: error.statusCode || 500,
           headers: {
               'Content-Type': 'application/json',
               'Access-Control-Allow-Origin': '*',
               'Access-Control-Allow-Methods': 'POST, OPTIONS',
               'Access-Control-Allow-Headers': 'Content-Type'
           },
           body: JSON.stringify({ 
               error: 'AnalysisError',
               message: error.message,
               timestamp: new Date().toISOString()
           })
       };
   }
};