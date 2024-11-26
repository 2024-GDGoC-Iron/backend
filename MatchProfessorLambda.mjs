import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const {
    PROFESSORS_TABLE_NAME,
    BEDROCK_MODEL_ID
} = process.env;

// 필수 환경변수 체크
if (!PROFESSORS_TABLE_NAME || !BEDROCK_MODEL_ID) {
    throw new Error('Required environment variables are missing');
}

// 클라이언트 초기화
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient());
const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });

const MATCHING_WEIGHTS = {
    RESEARCH_MATCH: 40,
    CAREER_MATCH: 30,
    DEPARTMENT_MATCH: 20,
    AVAILABILITY: 10
};

const MINIMUM_MATCH_SCORE = 30;

const safeGetAttribute = (item, path) => {
    try {
        const pathParts = path.split('.');
        let value = item;
        
        for (const part of pathParts) {
            value = value[part];
        }

        if (value?.S !== undefined) return value.S;
        if (value?.N !== undefined) return Number(value.N);
        if (value?.L !== undefined) return value.L.map(v => v.S);
        
        return value;
    } catch (error) {
        console.warn(`Failed to get attribute ${path}:`, error);
        return null;
    }
};

const calculateStringSimilarity = (str1, str2) => {
    if (!str1 || !str2) return 0;
    
    const processString = (str) => str.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    
    const words1 = processString(str1);
    const words2 = processString(str2);
    
    if (words1.length === 0 || words2.length === 0) return 0;
    
    let matches = 0;
    for (const word1 of words1) {
        for (const word2 of words2) {
            if (word2.includes(word1) || word1.includes(word2)) {
                matches += 1;
                if (word1 === word2) matches += 0.5;
            }
        }
    }
    
    return (2.0 * matches) / (words1.length + words2.length);
};

const adjustScoreRange = (originalScore) => {
    const normalizedScore = originalScore / 100;
    const adjustedScore = 60 + (normalizedScore * 30);
    return Math.round(adjustedScore);
};

const calculateMatchScore = (professor, analysis) => {
    try {
        let scores = {
            research: 0,
            career: 0,
            department: 0,
            availability: 0
        };

        const researchSimilarities = professor.researchAreas.map(area => {
            return analysis.studentProfile.interests.map(interest => {
                const similarity = calculateStringSimilarity(area, interest);
                return similarity;
            });
        }).flat();

        scores.research = Math.max(...researchSimilarities) * MATCHING_WEIGHTS.RESEARCH_MATCH;

        const careerSimilarities = professor.researchAreas.map(area => {
            const targetFieldSimilarity = calculateStringSimilarity(area, analysis.careerGoals.targetField);
            const pathTypeSimilarity = calculateStringSimilarity(area, analysis.careerGoals.pathType);
            return Math.max(targetFieldSimilarity, pathTypeSimilarity);
        });

        scores.career = Math.max(...careerSimilarities) * MATCHING_WEIGHTS.CAREER_MATCH;
        scores.department = professor.department === analysis.studentProfile.major ? 
            MATCHING_WEIGHTS.DEPARTMENT_MATCH : 0;
        scores.availability = professor.availableSlots > 0 ? 
            MATCHING_WEIGHTS.AVAILABILITY : 0;

        const originalScore = Object.values(scores).reduce((sum, score) => sum + score, 0);
        const adjustedScore = adjustScoreRange(originalScore);

        console.log('Matching details:', {
            professorId: professor.professorId,
            name: professor.name,
            scores,
            originalScore,
            adjustedScore
        });

        return adjustedScore;
    } catch (error) {
        console.error('Error calculating match score:', error);
        return 60;
    }
};

const calculateMatchingThreshold = (professor, analysis) => {
    let threshold = MINIMUM_MATCH_SCORE;

    if (professor.department === analysis.studentProfile.major) {
        threshold *= 0.8;
    }

    const overlap = professor.researchAreas.some(area =>
        analysis.studentProfile.interests.some(interest =>
            calculateStringSimilarity(area, interest) > 0.5
        )
    );

    if (overlap) {
        threshold *= 0.9;
    }

    return Math.max(threshold, 20);
};

const generateMatchReason = async (professor, analysis) => {
    try {
        const prompt = `
학생 정보:
- 학년: ${analysis.studentProfile.year}학년
- 전공: ${analysis.studentProfile.major}
- 학점: ${analysis.studentProfile.gpa}
- 관심분야: ${analysis.studentProfile.interests.join(', ')}
- 진로목표: ${analysis.careerGoals.pathType}
- 희망분야: ${analysis.careerGoals.targetField}
- 현재준비: ${analysis.careerGoals.preparation.join(', ')}
- 상담목적: ${analysis.consultingNeeds.mainPurpose}

교수 정보:
- 이름: ${professor.name}
- 학과: ${professor.department}
- 직위: ${professor.position}
- 연구분야: ${professor.researchAreas.join(', ')}
- 매칭점수: ${professor.matchScore}점

매칭 분석 지침:
1. 학생의 학업 배경과 교수의 전문성 연계성
2. 진로 목표와의 적합성
3. 구체적인 멘토링 가능 영역
4. 기대되는 성장 포인트

위 정보를 바탕으로 매칭의 적절성과 기대효과를 3-4문장으로 설명해주세요.
전문성과 관련성을 구체적으로 설명하고, 마지막에는 긍정적인 기대효과를 포함해주세요.`;

        const command = new InvokeModelCommand({
            modelId: BEDROCK_MODEL_ID,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 1000,
                temperature: 0.7,
                messages: [{
                    role: "user",
                    content: prompt
                }]
            })
        });

        const response = await bedrockClient.send(command);
        const parsed = JSON.parse(new TextDecoder().decode(response.body));
        
        return parsed.content[0].text.trim();
    } catch (error) {
        console.error('Error generating match reason:', error);
        return `${professor.name} 교수님은 ${professor.researchAreas.join(', ')} 분야의 전문가로서, 학생의 관심사 및 진로목표와 높은 연관성을 보입니다.`;
    }
};

const matchProfessor = async (analysis) => {
    try {
        if (!analysis?.studentProfile?.interests?.length || 
            !analysis?.careerGoals?.targetField) {
            throw new Error('Invalid analysis data: Missing required fields');
        }

        const { Items: professors } = await ddbClient.send(
            new ScanCommand({ 
                TableName: PROFESSORS_TABLE_NAME,
                Select: 'ALL_ATTRIBUTES'
            })
        );

        if (!professors?.length) {
            throw new Error('No professors found in database');
        }

        const scoredProfessors = professors
            .map(prof => {
                const professorData = {
                    professorId: safeGetAttribute(prof, 'professorId'),
                    name: safeGetAttribute(prof, 'name'),
                    department: safeGetAttribute(prof, 'department'),
                    position: safeGetAttribute(prof, 'position'),
                    email: safeGetAttribute(prof, 'email'),
                    location: safeGetAttribute(prof, 'location'),
                    researchAreas: safeGetAttribute(prof, 'researchAreas') || [],
                    availableSlots: safeGetAttribute(prof, 'availableSlots') || 0
                };

                const matchScore = calculateMatchScore(professorData, analysis);
                const threshold = calculateMatchingThreshold(professorData, analysis);

                return {
                    ...professorData,
                    matchScore,
                    threshold
                };
            })
            .filter(prof => prof.matchScore >= prof.threshold)
            .sort((a, b) => b.matchScore - a.matchScore);

        if (!scoredProfessors.length) {
            throw new Error('No suitable professor matches found');
        }

        const bestMatch = scoredProfessors[0];
        const matchReason = await generateMatchReason(bestMatch, analysis);

        return {
            match: {
                professor: bestMatch,
                matchReason,
                nextSteps: [
                    "1. 학과 사무실 방문하여 상담 신청",
                    "2. 성적표와 관련 자료 준비",
                    "3. 이메일로 사전 질문 목록 전송"
                ],
                alternativeMatches: scoredProfessors.slice(1, 3)
            },
            timestamp: new Date().toISOString()
        };

    } catch (error) {
        console.error('Matching error:', error);
        throw error;
    }
};

export const handler = async (event) => {
    console.log('Received event:', JSON.stringify(event));

    try {
        const { analysis } = event;
        if (!analysis) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({ 
                    error: 'ValidationError', 
                    message: 'Analysis data is required' 
                })
            };
        }

        const result = await matchProfessor(analysis);
        
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            },
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Handler error:', error);
        return {
            statusCode: error.message.includes('ValidationError') ? 400 : 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ 
                error: error.name || 'MatchingError',
                message: error.message,
                timestamp: new Date().toISOString()
            })
        };
    }
};