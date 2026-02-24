require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const Groq = require('groq-sdk');

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());


const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);




app.post('/token', async (req, res) => {
  try {
    const { name, room, role, className, topic } = req.body;
    console.log("📥 TOKEN REQUEST BODY:", req.body);

    if (!name || !room || !role) {
      return res.status(400).json({ error: "Missing name, room, or role" });
    }

    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.LIVEKIT_URL) {
      return res.status(500).json({ error: "LiveKit ENV variables missing" });
    }

    // Build metadata object
    const metadata = { role };

    // Add className and topic if provided (for teachers)
    if (className) metadata.className = className;
    if (topic) metadata.topic = topic;

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: name,
        metadata: JSON.stringify(metadata),
      }
    );

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canUpdateOwnMetadata: true,
    });

    const jwt = await at.toJwt();
    console.log("✅ TOKEN GENERATED for:", name, "ROLE:", role, className ? `CLASS: ${className}` : '', topic ? `TOPIC: ${topic}` : '');

    res.json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
    });
  } catch (e) {
    console.error("❌ TOKEN ERROR:", e);
    res.status(500).json({ error: "Token generation failed" });
  }
});


app.post('/ask-ai', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content:
            'You are a teacher assistant. Give SHORT and SWEET answers only — maximum 1 to 2 sentences. Use simple language a student can understand. No bullet points, no long explanations. Be direct and concise.',
        },
        {
          role: 'user',
          content: question,
        },
      ],
      temperature: 0.3,
      max_tokens: 150,
    });

    const answer = completion.choices[0]?.message?.content;

    res.json({ answer });
  } catch (err) {
    console.error('❌ GROQ ERROR:', err);
    res.status(500).json({ error: 'AI response failed' });
  }
});


// 🎤 Extract Question from Voice Transcript
app.post('/extract-question', async (req, res) => {
  try {
    const { transcript } = req.body;

    if (!transcript) {
      return res.status(400).json({ error: 'Transcript is required' });
    }

    const prompt = `You are a strict classroom assistant. 
Extract ONLY the core academic question from the transcript.

RULES:
- If the transcript ONLY contains greetings, meta-talk (like "I have a doubt", "Wait", "One more thing"), or teacher-student chatter WITHOUT a specific subject-matter question, you MUST return exactly: <NONE>
- DO NOT extract meta-sentences like "I have one doubt" or "I have a question".
- If a question is found, return ONLY the question text (e.g. "What is Python?").
- If NO specific question about the subject is found, return exactly: <NONE>

EXAMPLES:
Transcript: "Hi ma'am, I have one doubt." -> Output: <NONE>
Transcript: "Hello teacher, can you hear me? Yes. Okay, I have a doubt. What is a variable?" -> Output: What is a variable?
Transcript: "I have one more doubt." -> Output: <NONE>
Transcript: "Ma'am, please explain the difference between list and tuple." -> Output: please explain the difference between list and tuple.

Transcript:
"${transcript}"

Extracted Question:`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'You extract core questions from classroom dialogue. Return only the extracted question text, or an empty string if none found.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1,
    });

    const extractedQuestion = completion.choices[0]?.message?.content?.trim().replace(/^"|"$/g, '');

    res.json({ extractedQuestion });
  } catch (err) {
    console.error('❌ EXTRACTION ERROR:', err);
    res.status(500).json({ error: 'Question extraction failed' });
  }
});

// 📝 Quiz Storage (in-memory)
const quizzes = {}; // { quizId: { roomName, topic, questions, submissions: [] } }

// 🎯 Generate Quiz
app.post('/generate-quiz', async (req, res) => {
  try {
    const { topic, studentQuestions, roomName } = req.body;

    if (!topic || !roomName) {
      return res.status(400).json({ error: 'Topic and roomName are required' });
    }

    // Build context from student questions
    const questionsContext = studentQuestions && studentQuestions.length > 0
      ? `\n\nStudent questions during the session:\n${studentQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : '';

    const prompt = `You are an educational quiz generator. Generate a quiz with 5-10 multiple choice questions based on the following topic and student questions.

Topic: ${topic}${questionsContext}

Generate questions that:
1. Cover the main topic comprehensively
2. Address concepts from student questions if provided
3. Have 4 options each (A, B, C, D)
4. Have exactly one correct answer
5. Are educational and appropriate

Return ONLY a valid JSON array in this exact format, with no additional text:
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctAnswer": 0
  }
]

The correctAnswer should be the index (0-3) of the correct option.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'You are a quiz generator. Return only valid JSON arrays with no additional text or formatting.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.7,
    });

    let quizQuestions;
    try {
      const responseText = completion.choices[0]?.message?.content.trim();
      // Remove markdown code blocks if present
      const jsonText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      quizQuestions = JSON.parse(jsonText);

      if (!Array.isArray(quizQuestions)) {
        throw new Error('AI did not return a JSON array');
      }
    } catch (parseError) {
      console.error('❌ JSON Parse Error:', parseError);
      return res.status(500).json({ error: 'Failed to parse quiz questions or AI returned invalid format' });
    }

    // Generate unique quiz ID
    const quizId = `quiz_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store quiz
    quizzes[quizId] = {
      roomName,
      topic,
      questions: quizQuestions,
      submissions: [],
      createdAt: new Date().toISOString(),
    };

    console.log(`✅ Quiz generated: ${quizId} for room: ${roomName}`);

    res.json({
      quizId,
      questions: quizQuestions.map((q, idx) => ({
        id: idx,
        question: q.question,
        options: q.options,
      })),
    });
  } catch (err) {
    console.error('❌ QUIZ GENERATION ERROR:', err);
    res.status(500).json({ error: 'Quiz generation failed' });
  }
});

// 📤 Submit Quiz
app.post('/submit-quiz', async (req, res) => {
  try {
    const { quizId, studentName, answers } = req.body;

    if (!quizId || !studentName || !answers) {
      return res.status(400).json({ error: 'quizId, studentName, and answers are required' });
    }

    const quiz = quizzes[quizId];
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Grade the quiz
    let correctCount = 0;
    const results = quiz.questions.map((q, idx) => {
      const studentAnswer = answers[idx];
      const isCorrect = studentAnswer === q.correctAnswer;
      if (isCorrect) correctCount++;

      return {
        questionId: idx,
        question: q.question,
        studentAnswer,
        correctAnswer: q.correctAnswer,
        isCorrect,
      };
    });

    const score = Math.round((correctCount / quiz.questions.length) * 100);

    // Store submission
    const submission = {
      studentName,
      answers,
      score,
      correctCount,
      totalQuestions: quiz.questions.length,
      submittedAt: new Date().toISOString(),
    };

    quiz.submissions.push(submission);

    console.log(`✅ Quiz submitted by ${studentName}: ${score}%`);

    res.json({
      score,
      correctCount,
      totalQuestions: quiz.questions.length,
      results,
    });
  } catch (err) {
    console.error('❌ QUIZ SUBMISSION ERROR:', err);
    res.status(500).json({ error: 'Quiz submission failed' });
  }
});

// 📊 Get Quiz Results (Teacher)
app.get('/quiz-results/:quizId', (req, res) => {
  try {
    const { quizId } = req.params;

    const quiz = quizzes[quizId];
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Calculate statistics
    const scores = quiz.submissions.map(s => s.score);
    const stats = {
      totalSubmissions: quiz.submissions.length,
      averageScore: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      highestScore: scores.length > 0 ? Math.max(...scores) : 0,
      lowestScore: scores.length > 0 ? Math.min(...scores) : 0,
    };

    res.json({
      quizId,
      topic: quiz.topic,
      roomName: quiz.roomName,
      createdAt: quiz.createdAt,
      questions: quiz.questions,
      submissions: quiz.submissions,
      stats,
    });
  } catch (err) {
    console.error('❌ QUIZ RESULTS ERROR:', err);
    res.status(500).json({ error: 'Failed to fetch quiz results' });
  }
});

// 🚪 End Meeting (Delete Room)
app.post('/end-room', async (req, res) => {
  try {
    const { roomName } = req.body;
    if (!roomName) {
      return res.status(400).json({ error: "roomName is required" });
    }

    await roomService.deleteRoom(roomName);
    console.log(`🗑️ Room ${roomName} has been ended by teacher.`);
    res.json({ success: true, message: `Room ${roomName} ended.` });
  } catch (e) {
    console.error("❌ END ROOM ERROR:", e);
    res.status(500).json({ error: "Failed to end room" });
  }
});


// 📝 Generate Class Summary
app.post('/generate-summary', async (req, res) => {
  try {
    const { topic, studentQuestions } = req.body;

    if (!topic) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    const questionsContext = studentQuestions && studentQuestions.length > 0
      ? `\n\nStudent questions during the session:\n${studentQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : '';

    const prompt = `You are an educational assistant. Provide a concise summary of the class based on the topic and student questions.
    
Topic: ${topic}${questionsContext}

Rules:
1. Keep the summary under 50 words.
2. Highlight the key concepts discussed.
3. Use a professional and encouraging tone.
4. Return ONLY the summary text.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'You are an educational assistant. Provide concise class summaries.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.5,
    });

    const summary = completion.choices[0]?.message?.content.trim() || 'No summary available.';

    res.json({ summary });
  } catch (err) {
    console.error('❌ SUMMARY GENERATION ERROR:', err);
    res.status(500).json({ error: 'Summary generation failed' });
  }
});

app.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
