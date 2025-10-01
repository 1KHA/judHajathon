const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  path: '/socket.io/',
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// Health check endpoint for Vercel
app.get('/api/health', (req, res) => {
  res.status(200).send('OK');
});

let judgePIN = '1234';
let players = {};
let teams = [];
let currentTeamIndex = 0;
let answersByTeam = {};
let currentSession = null;
let sessions = new Map(); // Track multiple sessions by sessionId

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('join-judging', async (pin, name) => {
    if (!name || name.trim() === '') {
      socket.emit('error-message', 'Name is required');
      return;
    }

    if (pin === judgePIN) {
      try {
        // Generate judge token
        const judgeToken = uuidv4();
        
        // Create or find judge in database and update with token and session
        const judge = await prisma.judge.upsert({
          where: { name },
          create: { 
            name,
            judgeToken,
            sessionId: currentSession?.id || null
          },
          update: { 
            judgeToken,
            sessionId: currentSession?.id || null
          }
        });
        
        players[socket.id] = { name, score: 0 };
        socket.join('judge');
        socket.emit('joined-success', { 
          name, 
          judgeToken,
          sessionId: currentSession?.sessionId || null
        });
        io.to('judge').emit('participant-list', Object.values(players));
        io.to('host').emit('judge-list', Object.values(players));
        console.log(`Judge created: ${name} (ID: ${judge.id}) with token`);
      } catch (error) {
        console.error('Error creating judge:', error);
        socket.emit('error-message', 'Failed to join session');
      }
    } else {
      socket.emit('error-message', 'Invalid Game PIN');
    }
  });

  socket.on('set-teams', async (teamNames) => {
    console.log('Received teams:', teamNames);
    if (!teamNames || teamNames.length === 0) {
      console.error('No teams received');
      socket.emit('error-message', 'Please select at least one team');
      return;
    }

    // Create new session with unique ID and host token
    const sessionId = uuidv4();
    const hostToken = uuidv4();
    
    currentSession = await prisma.session.create({
      data: {
        name: `Session ${sessionId}`,
        sessionId: sessionId,
        hostToken: hostToken,
        currentTeamIndex: 0,
        teams: JSON.stringify(teamNames),
        answersByTeam: JSON.stringify({})
      }
    });

    // Link selected teams to the session via SessionTeam
    const allTeams = await prisma.team.findMany({
      where: { name: { in: teamNames } }
    });

    for (const team of allTeams) {
      await prisma.sessionTeam.create({
        data: {
          session: { connect: { id: currentSession.id } },
          team: { connect: { id: team.id } }
        }
      });
    }

    // Store session in sessions map
    sessions.set(sessionId, {
      session: currentSession,
      teams: teamNames,
      currentTeamIndex: 0,
      answersByTeam: {}
    });

    // Emit session created event with session ID and host token
    socket.emit('session-created', { 
      sessionId,
      hostToken,
      teams: teamNames 
    });

    // Update in-memory state
    teams = teamNames;
    currentTeamIndex = 0;
    answersByTeam = {};
    console.log('Teams set:', teams);
    console.log('Session created:', currentSession);
    socket.emit('teams-set', teams);
    io.to('host').emit('team-changed', teams[currentTeamIndex]);
  });

  socket.on('start-question', async (questionIds) => {
    if (!currentSession) {
      console.error('No active session');
      return;
    }

    try {
      // Link selected questions to the session via SessionQuestion
      const questionIdInts = questionIds.map(q => parseInt(q.id));
      const allQuestions = await prisma.question.findMany({
        where: { id: { in: questionIdInts } }
      });

      for (const question of allQuestions) {
        // Check if already linked
        const exists = await prisma.sessionQuestion.findFirst({
          where: {
            sessionId: currentSession.id,
            questionId: question.id
          }
        });
        if (!exists) {
          await prisma.sessionQuestion.create({
            data: {
              session: { connect: { id: currentSession.id } },
              question: { connect: { id: question.id } }
            }
          });
        }
      }

      // Get all questions linked to this session
      const sessionQuestions = await prisma.sessionQuestion.findMany({
        where: { sessionId: currentSession.id },
        include: { question: true }
      });
      const questions = sessionQuestions.map(sq => sq.question);

      console.log('Sending questions to judges:', questions);
      console.log('Current team:', teams[currentTeamIndex]);

      // Find the team ID for the current team
      const team = await prisma.team.findFirst({
        where: { name: teams[currentTeamIndex] }
      });

      // Store current questions and team in session for judge rejoin
      await prisma.session.update({
        where: { id: currentSession.id },
        data: {
          currentQuestions: JSON.stringify(allQuestions),
          currentTeamId: team?.id || null
        }
      });

      io.to('judge').emit('question', {
        questions,
        currentTeam: teams[currentTeamIndex],
        teamId: team?.id || 0
      });

      // Log session state
      console.log('Session state:', {
        currentSession,
        teams,
        currentTeamIndex,
        answersByTeam
      });
    } catch (error) {
      console.error('Error saving questions:', error);
    }
  });

  socket.on('join-host', async () => {
    socket.join('host');
    // Send existing teams, questions and question banks to host
    const teams = await prisma.team.findMany({
      distinct: ['name'],
      select: { name: true }
    });
    console.log('Fetched teams from database:', teams);
    
    const questions = await prisma.question.findMany({
      distinct: ['text'],
      select: { id: true, text: true, section: true, weight: true }
    });
    const questionBanks = await prisma.questionBank.findMany({
      include: {
        questions: {
          select: { id: true, text: true, section: true, weight: true }
        }
      }
    });
    
    const initData = { 
      teams: teams.map(t => t.name),
      questions,
      questionBanks,
      sections: [...new Set(questions.map(q => q.section))]
    };
    
    console.log('Sending init-host-data:', initData);
    socket.emit('init-host-data', initData);
  });

  // Host rejoin functionality
  socket.on('rejoin-host', async ({ sessionId, hostToken }) => {
    try {
      // Validate token and session
      const session = await prisma.session.findFirst({
        where: {
          sessionId: sessionId,
          hostToken: hostToken
        },
        include: {
          sessionTeams: {
            include: { team: true }
          },
          sessionQuestions: {
            include: { question: true }
          }
        }
      });

      if (!session) {
        socket.emit('rejoin-failed', 'Invalid session or token');
        return;
      }

      // Restore session state
      currentSession = session;
      teams = session.teams ? JSON.parse(session.teams) : session.sessionTeams.map(st => st.team.name);
      currentTeamIndex = session.currentTeamIndex || 0;
      answersByTeam = session.answersByTeam ? JSON.parse(session.answersByTeam) : {};
      
      // Store session in sessions map
      sessions.set(sessionId, {
        session,
        teams,
        currentTeamIndex,
        answersByTeam
      });

      socket.join('host');

      // Get all available teams, questions and question banks for the UI
      const allTeams = await prisma.team.findMany({
        distinct: ['name'],
        select: { name: true }
      });
      const allQuestions = await prisma.question.findMany({
        distinct: ['text'],
        select: { id: true, text: true, section: true, weight: true }
      });
      const questionBanks = await prisma.questionBank.findMany({
        include: {
          questions: {
            select: { id: true, text: true, section: true, weight: true }
          }
        }
      });

      // Emit full host data to restore UI
      socket.emit('init-host-data', { 
        teams: allTeams.map(t => t.name),
        questions: allQuestions,
        questionBanks,
        sections: [...new Set(allQuestions.map(q => q.section))]
      });

      // Emit rejoin success with session state
      socket.emit('host-rejoined', {
        sessionId: session.sessionId,
        teams,
        currentTeam: teams[currentTeamIndex],
        currentTeamIndex
      });

      // Restore teams selection in UI
      socket.emit('teams-set', teams);
      
      // Restore current team
      socket.emit('team-changed', teams[currentTeamIndex]);

      // Restore answers if any
      if (Object.keys(answersByTeam).length > 0) {
        socket.emit('answers-updated', answersByTeam);
      }

      console.log(`Host rejoined session: ${sessionId}`);
    } catch (error) {
      console.error('Error rejoining host:', error);
      socket.emit('rejoin-failed', 'Failed to rejoin session');
    }
  });

  // Judge rejoin functionality
  socket.on('rejoin-judge', async ({ sessionId, judgeName, judgeToken }) => {
    try {
      console.log(`Judge rejoin attempt: name=${judgeName}, sessionId=${sessionId}, token=${judgeToken}`);
      
      // First find the session by sessionId (UUID string)
      const session = await prisma.session.findFirst({
        where: { sessionId: sessionId }
      });

      if (!session) {
        console.log(`Session not found for sessionId: ${sessionId}`);
        socket.emit('rejoin-failed', 'Session not found');
        return;
      }

      console.log(`Found session: ${session.id} (${session.sessionId})`);

      // Validate token and judge using the session's database ID
      const judge = await prisma.judge.findFirst({
        where: {
          name: judgeName,
          judgeToken: judgeToken,
          sessionId: session.id
        }
      });

      if (!judge) {
        console.log(`Judge not found: name=${judgeName}, token=${judgeToken}, sessionId=${session.id}`);
        socket.emit('rejoin-failed', 'Invalid judge token or session');
        return;
      }

      console.log(`Found judge: ${judge.id} (${judge.name})`);

      // Restore player state
      players[socket.id] = { name: judgeName, score: 0 };
      socket.join('judge');
      
      socket.emit('judge-rejoined', {
        name: judgeName,
        sessionId: session.sessionId
      });

      // Update participant lists
      io.to('judge').emit('participant-list', Object.values(players));
      io.to('host').emit('judge-list', Object.values(players));

      // If there are current questions, send them to the rejoining judge
      if (session.currentQuestions && session.currentTeamId) {
        const currentQuestions = JSON.parse(session.currentQuestions);
        const currentTeam = await prisma.team.findFirst({
          where: { id: session.currentTeamId }
        });

        if (currentQuestions.length > 0 && currentTeam) {
          console.log(`Sending current questions to rejoining judge: ${judgeName}`);
          socket.emit('question', {
            questions: currentQuestions,
            currentTeam: currentTeam.name,
            teamId: currentTeam.id
          });
        }
      }

      console.log(`Judge ${judgeName} rejoined session: ${session.sessionId}`);
    } catch (error) {
      console.error('Error rejoining judge:', error);
      socket.emit('rejoin-failed', 'Failed to rejoin session');
    }
  });

  socket.on('save-questions', async ({questions, totalPoints, bankName}) => {
    try {
      let bank;
      if (!bankName || !bankName.trim()) {
        socket.emit('error-message', 'A question bank name is required. Please provide a bank name to save questions.');
        return;
      }
      // Create or update question bank
      bank = await prisma.questionBank.upsert({
        where: { name: bankName },
        create: { name: bankName },
        update: {}
      });
      console.log('Bank created/updated:', bank);

      // Only update session if one exists (not required for saving questions)
      if (currentSession) {
        // Update session with total points
        await prisma.session.update({
          where: { id: currentSession.id },
          data: { totalPoints: parseInt(totalPoints) }
        });
      }

      // Enhanced validation for questions and choices
      for (const [i, q] of questions.entries()) {
        if (!q.text || !q.choices || !q.section || typeof q.weight === 'undefined') {
          socket.emit('error-message', `Invalid question data at index ${i}. All fields are required.`);
          console.error('Invalid question data:', q);
          return;
        }
        if (!Array.isArray(q.choices) || q.choices.length < 1) {
          socket.emit('error-message', `Question at index ${i} must have at least one choice.`);
          console.error('Invalid choices for question:', q);
          return;
        }
        for (const [j, choice] of q.choices.entries()) {
          if (
            typeof choice !== 'object' ||
            typeof choice.text !== 'string' ||
            choice.text.trim() === '' ||
            typeof choice.weight === 'undefined'
          ) {
            socket.emit('error-message', `Invalid choice at index ${j} for question ${i}. Each choice must have text and weight.`);
            console.error('Invalid choice:', choice, 'in question:', q);
            return;
          }
        }
      }
      // Log all questions to be created
      console.log('Validated questions to be created:', questions);

      // Create new questions, always using the upserted bank's ID if present
      if (!questions.length) {
        socket.emit('error-message', 'No questions to save.');
        return;
      }

      const createdQuestions = await prisma.$transaction(
        questions.map(q => prisma.question.create({
          data: {
            text: q.text,
            choices: q.choices,
            ...(q.correct ? { correct: q.correct } : {}),
            section: q.section,
            weight: q.weight,
            ...(bank ? { bank: { connect: { id: bank.id } } } : {})
          }
        }))
      );
      console.log('Questions created:', createdQuestions.map(q => ({ id: q.id, text: q.text, bankId: q.bankId })));

      // Calculate points distribution
      const categories = createdQuestions.reduce((acc, q) => {
        const existing = acc.find(c => c.name === q.section);
        if (existing) {
          existing.questions++;
        } else {
          acc.push({ name: q.section, weight: q.weight, questions: 1 });
        }
        return acc;
      }, []);

      const pointsDistribution = calculatePointsDistribution(
        categories,
        totalPoints || 100
      );

      socket.emit('questions-saved', {
        questions: createdQuestions,
        pointsDistribution
      });
      console.log('Questions saved:', createdQuestions.length);

      // Fetch and emit updated question banks with questions to host
      const questionBanks = await prisma.questionBank.findMany({
        include: {
          questions: {
            select: { id: true, text: true, section: true, weight: true }
          }
        }
      });
      // Broadcast updated question banks to all hosts
      io.to('host').emit('init-host-data', {
        questionBanks
      });
    } catch (error) {
      console.error('Error saving questions:', error);
      socket.emit('error-message', 'Failed to save questions');
    }
  });

  // Centralized utility functions for points calculation
  function calculatePointsDistribution(categories, totalPoints) {
    const totalWeight = categories.reduce((sum, cat) => sum + cat.weight, 0);
    return categories.map(cat => {
      const categoryPoints = (cat.weight / totalWeight) * totalPoints;
      const pointsPerQuestion = categoryPoints / cat.questions;

      return {
        name: cat.name,
        weight: cat.weight,
        questions: cat.questions,
        totalPoints: Number(categoryPoints.toFixed(2)),
        pointsPerQuestion: Number(pointsPerQuestion.toFixed(2))
      };
    });
  }

  // Calculate points for a single answer based on option weight and question weight
  function calculateAnswerPoints(question, answerText) {
    if (!question || !question.choices) return 0;
    
    // Find the selected option
    const selectedOption = typeof answerText === 'object' 
      ? question.choices.find(opt => opt.text === answerText.text)
      : question.choices.find(opt => opt.text === answerText);
    
    if (!selectedOption) return 0;
    
    // Calculate points based on option weight and question weight
    const maxOptionWeight = Math.max(...question.choices.map(o => o.weight || 0));
    return (selectedOption.weight / maxOptionWeight) * (question.weight || 1);
  }

  // Normalize total points based on session total points setting
  function normalizePoints(rawPoints, questions, sessionTotalPoints) {
    if (!sessionTotalPoints || !questions || questions.length === 0) return rawPoints;
    
    // Calculate maximum possible score
    const maxPossibleScore = questions.reduce((sum, q) => {
      return sum + (q.weight || 1);
    }, 0);
    
    if (maxPossibleScore <= 0) return rawPoints;
    
    // Normalize to session total points - ensure we're using the user-defined total points
    // and not a default value
    return rawPoints; // Return raw points without normalization
  }

  socket.on('next-team', async () => {
    if (currentTeamIndex < teams.length - 1) {
      currentTeamIndex++;
      
      // Update session state in database
      if (currentSession) {
        await prisma.session.update({
          where: { id: currentSession.id },
          data: { 
            currentTeamIndex,
            answersByTeam: JSON.stringify(answersByTeam)
          }
        });
      }
      
      io.to('host').emit('team-changed', teams[currentTeamIndex]);
    }
  });

  socket.on('previous-team', async () => {
    if (currentTeamIndex > 0) {
      currentTeamIndex--;
      
      // Update session state in database
      if (currentSession) {
        await prisma.session.update({
          where: { id: currentSession.id },
          data: { 
            currentTeamIndex,
            answersByTeam: JSON.stringify(answersByTeam)
          }
        });
      }
      
      io.to('host').emit('team-changed', teams[currentTeamIndex]);
    }
  });

  socket.on('start-session', () => {
    if (!currentSession) {
      socket.emit('error-message', 'No session created yet');
      return;
    }
    
    // Broadcast session ID to all connected clients
    io.emit('session-started', currentSession.sessionId);
    console.log(`Session started with ID: ${currentSession.sessionId}`);
  });

  socket.on('end-session', async () => {
    if (!currentSession) {
      socket.emit('error-message', 'No active session to end');
      return;
    }

    try {
      // Mark session as ended by clearing the host token
      await prisma.session.update({
        where: { id: currentSession.id },
        data: { 
          hostToken: null // Invalidate the host token
        }
      });

      // Clear all judge tokens for this session
      await prisma.judge.updateMany({
        where: { sessionId: currentSession.id },
        data: { 
          judgeToken: null,
          sessionId: null
        }
      });

      // Remove from sessions map
      if (currentSession.sessionId) {
        sessions.delete(currentSession.sessionId);
      }

      // Clear in-memory state
      currentSession = null;
      teams = [];
      currentTeamIndex = 0;
      answersByTeam = {};
      players = {};

      // Notify all clients
      io.to('judge').emit('session-ended');
      io.to('host').emit('session-ended');
      
      console.log('Session ended and cleaned up');
    } catch (error) {
      console.error('Error ending session:', error);
      socket.emit('error-message', 'Failed to end session');
    }
  });

    socket.on('submit-answer', async (answerData) => {
      const playerName = players[socket.id]?.name;
      if (!playerName) {
        console.error('No player name found for socket:', socket.id);
        return;
      }
      
      const answerText = answerData.answer || answerData;
      const questionIndex = answerData.questionIndex;
      const currentTeam = teams[currentTeamIndex];

      // Create or find judge
      let judge;
      try {
        judge = await prisma.judge.upsert({
          where: { name: playerName },
          create: { name: playerName },
          update: {}
        });
      } catch (error) {
        console.error('Error creating/finding judge:', error);
        return;
      }

      // Find the team
      const team = await prisma.team.findFirst({
        where: { name: currentTeam }
      });

      if (!team) {
        console.error('Team not found:', currentTeam);
        return;
      }

      try {
        // Save answer to database
        // Extract answer text if it's an object, otherwise use as-is
        const answerTextValue = typeof answerText === 'object' ? answerText.text : answerText;

        // First verify the question is linked to the current session via SessionQuestion
        const sessionQuestion = await prisma.sessionQuestion.findFirst({
          where: {
            sessionId: currentSession.id,
            questionId: questionIndex
          },
          include: { question: true }
        });

        if (!sessionQuestion) {
          console.error(`Question with ID ${questionIndex} not linked to session ${currentSession.id}`);
          return;
        }

        const question = sessionQuestion.question;

        // Calculate points using the centralized utility function
        const points = calculateAnswerPoints(question, answerText);

        const savedAnswer = await prisma.answer.create({
          data: {
            answer: answerTextValue,
            points: points,
            question: { connect: { id: questionIndex } },
            team: { connect: { id: team.id } },
            judge: { connect: { id: judge.id } },
            session: { connect: { id: currentSession.id } }
          }
        });
        console.log('Answer saved:', savedAnswer);

        // Get all answers for this team in this session
        const teamAnswers = await prisma.answer.findMany({
          where: {
            teamId: team.id,
            sessionId: currentSession.id
          },
          include: {
            question: true,
            judge: true
          }
        });

        // Save team result
        await saveTeamResult(currentSession.id, team.id, teamAnswers);
      } catch (error) {
        console.error('Error saving answer:', error);
        return;
      }

      // Update in-memory state
      if (!answersByTeam[currentTeam]) {
        answersByTeam[currentTeam] = [];
      }
      answersByTeam[currentTeam].push({
        player: playerName,
        answer: answerText,
        points: answerData.points || 0
      });
      
      io.to('host').emit('answers-updated', answersByTeam);
    });

    socket.on('submit-final-answers', async ({teamId, answers}) => {
      const playerName = players[socket.id]?.name;
      if (!playerName) {
        socket.emit('error-message', 'Not authenticated');
        return;
      }

      try {
        const judge = await prisma.judge.findUnique({
          where: { name: playerName }
        });

        // First save the final answers
        await prisma.finalAnswer.upsert({
          where: {
            sessionId_teamId_judgeId: {
              sessionId: currentSession.id,
              teamId: parseInt(teamId),
              judgeId: judge.id
            }
          },
          create: {
            sessionId: currentSession.id,
            teamId: parseInt(teamId),
            judgeId: judge.id,
            answers: JSON.stringify(answers)
          },
          update: {
            answers: JSON.stringify(answers)
          }
        });

        // Get all questions for this session via SessionQuestion join table
        const sessionQuestions = await prisma.sessionQuestion.findMany({
          where: { sessionId: currentSession.id },
          include: { question: true }
        });
        const questions = sessionQuestions.map(sq => sq.question);

        // Get all final answers for this team to calculate final score
        const allFinalAnswers = await prisma.finalAnswer.findMany({
          where: {
            sessionId: currentSession.id,
            teamId: parseInt(teamId)
          }
        });

        // Calculate total points from all judges' answers using the centralized utility functions
        let totalPoints = 0;
        allFinalAnswers.forEach(finalAnswer => {
          const answers = JSON.parse(finalAnswer.answers);
          answers.forEach(answer => {
            const question = questions.find(q => q.id === answer.questionIndex);
            if (question) {
              totalPoints += calculateAnswerPoints(question, answer.answer);
            }
          });
        });

        // Normalize points based on session total points using the centralized utility function
        totalPoints = normalizePoints(totalPoints, questions, currentSession.totalPoints);
        totalPoints = Math.round(totalPoints * 100) / 100; // Round to 2 decimal places

        // Get judge names and process answers with detailed information
        const judgeAnswers = await Promise.all(
          allFinalAnswers.map(async fa => {
            const judge = await prisma.judge.findUnique({where: {id: fa.judgeId}});
            const answers = JSON.parse(fa.answers);
            
            // Process each answer to include weights and calculation details
            const processedAnswers = answers.map(answer => {
              const question = questions.find(q => q.id === answer.questionIndex);
              let optionWeight = 0;
              let maxOptionWeight = 0;
              let points = 0;
              
              if (question && question.choices) {
                const selectedOption = question.choices.find(opt => opt.text === answer.answer);
                optionWeight = selectedOption ? selectedOption.weight : 0;
                maxOptionWeight = Math.max(...question.choices.map(o => o.weight || 0));
                const questionWeight = question.weight || 1;
                points = (optionWeight / maxOptionWeight) * questionWeight;
              }
              
              return {
                questionText: question?.text || 'Unknown Question',
                questionWeight: question?.weight || 1,
                judgeName: judge?.name || 'Unknown',
                answer: answer.answer,
                optionWeight: optionWeight,
                maxOptionWeight: maxOptionWeight,
                points: points
              };
            });
            
            return processedAnswers;
          })
        );
        
        // Flatten the array of arrays into a single array of answers
        const allDetailedAnswers = judgeAnswers.flat();

        // Save final result
        await prisma.sessionResult.upsert({
          where: {
            sessionId_teamId: {
              sessionId: currentSession.id,
              teamId: parseInt(teamId)
            }
          },
          create: {
            sessionId: currentSession.id,
            teamId: parseInt(teamId),
            totalPoints,
            details: JSON.stringify({
              answers: allDetailedAnswers
            })
          },
          update: {
            totalPoints,
            details: JSON.stringify({
              answers: allDetailedAnswers
            })
          }
        });

        // Update leaderboard
        const results = await prisma.sessionResult.findMany({
          where: { sessionId: currentSession.id },
          include: { team: true }
        });

        // For each result, recalculate the total points as the sum of the detailed points
        const leaderboard = await Promise.all(results.map(async (result) => {
          // Parse the details to get the answers
          const details = JSON.parse(result.details);
          const answers = details.answers || [];
          
          // Calculate the total points as the sum of the points for each answer
          const totalPoints = answers.reduce((sum, answer) => {
            return sum + (parseFloat(answer.points) || 0);
          }, 0);
          
          return {
            teamName: result.team.name,
            totalPoints: Math.round(totalPoints * 100) / 100 // Round to 2 decimal places
          };
        }));
        
        // Sort by total points in descending order
        leaderboard.sort((a, b) => b.totalPoints - a.totalPoints);

        io.to('host').emit('leaderboard-updated', leaderboard);
        socket.emit('final-answers-submitted');
    } catch (error) {
      console.error('Error saving final answers:', error);
      socket.emit('error-message', 'Failed to save final answers');
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.to('judge').emit('participant-list', Object.values(players));
  });

  socket.on('get-all-results', async () => {
    try {
      const results = await prisma.session.findMany({
        include: {
          results: {
            include: {
              team: true
            }
          }
        }
      });
      socket.emit('all-results', results);
    } catch (error) {
      console.error('Error fetching results:', error);
    }
  });
  
  socket.on('request-leaderboard', async () => {
    if (!currentSession) {
      return; // No active session
    }
    
    try {
      // Get all results for the current session
      const results = await prisma.sessionResult.findMany({
        where: { sessionId: currentSession.id },
        include: { 
          team: true,
          session: true
        }
      });
      
      // For each result, recalculate the total points as the sum of the detailed points
      const leaderboard = await Promise.all(results.map(async (result) => {
        // Parse the details to get the answers
        const details = JSON.parse(result.details);
        const answers = details.answers || [];
        
        // Calculate the total points as the sum of the points for each answer
        const totalPoints = answers.reduce((sum, answer) => {
          return sum + (parseFloat(answer.points) || 0);
        }, 0);
        
        return {
          teamName: result.team.name,
          totalPoints: Math.round(totalPoints * 100) / 100 // Round to 2 decimal places
        };
      }));
      
      // Sort by total points in descending order
      leaderboard.sort((a, b) => b.totalPoints - a.totalPoints);
      
      // Emit the leaderboard to the client
      socket.emit('leaderboard-updated', leaderboard);
    } catch (error) {
      console.error('Error fetching leaderboard:', error);
    }
  });

  async function saveTeamResult(sessionId, teamId, answers) {
    try {
      // Calculate total points from answers and normalize based on session total points
      const session = await prisma.session.findUnique({
        where: { id: sessionId }
      });
      
      // Get raw points from answers
      let totalPoints = answers.reduce((sum, answer) => sum + (answer.points || 0), 0);
      
      // Normalize using the centralized utility function
      const questions = answers.map(a => a.question).filter(q => q);
      totalPoints = normalizePoints(totalPoints, questions, session?.totalPoints);
      totalPoints = Math.round(totalPoints * 100) / 100; // Round to 2 decimal places
      
      // Save result
      await prisma.sessionResult.upsert({
        where: {
          sessionId_teamId: {
            sessionId,
            teamId
          }
        },
        create: {
          sessionId,
          teamId,
          totalPoints,
          details: JSON.stringify({
            answers: answers.map(a => {
              // Find the selected option to get its weight
              let optionWeight = 0;
              let maxOptionWeight = 0;
              if (a.question && a.question.choices) {
                const choices = a.question.choices;
                const selectedOption = choices.find(c => c.text === a.answer);
                optionWeight = selectedOption ? selectedOption.weight : 0;
                maxOptionWeight = Math.max(...choices.map(c => c.weight || 0));
              }
              
              return {
                questionText: a.question?.text,
                questionWeight: a.question?.weight || 1,
                judgeName: a.judge?.name,
                answer: a.answer,
                optionWeight: optionWeight,
                maxOptionWeight: maxOptionWeight,
                points: a.points
              };
            })
          })
        },
        update: {
          totalPoints,
          details: JSON.stringify({
            answers: answers.map(a => {
              // Find the selected option to get its weight
              let optionWeight = 0;
              let maxOptionWeight = 0;
              if (a.question && a.question.choices) {
                const choices = a.question.choices;
                const selectedOption = choices.find(c => c.text === a.answer);
                optionWeight = selectedOption ? selectedOption.weight : 0;
                maxOptionWeight = Math.max(...choices.map(c => c.weight || 0));
              }
              
              return {
                questionText: a.question?.text,
                questionWeight: a.question?.weight || 1,
                judgeName: a.judge?.name,
                answer: a.answer,
                optionWeight: optionWeight,
                maxOptionWeight: maxOptionWeight,
                points: a.points
              };
            })
          })
        }
      });
    } catch (error) {
      console.error('Error saving team result:', error);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
