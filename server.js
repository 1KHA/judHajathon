const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

app.use(express.static('public'));

let judgePIN = '1234';
let players = {};
let teams = [];
let currentTeamIndex = 0;
let answersByTeam = {};
let currentSession = null;

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('join-judging', async (pin, name) => {
    if (!name || name.trim() === '') {
      socket.emit('error-message', 'Name is required');
      return;
    }

    if (pin === judgePIN) {
      try {
        // Create or find judge in database
        const judge = await prisma.judge.upsert({
          where: { name },
          create: { name },
          update: {}
        });
        
        players[socket.id] = { name, score: 0 };
        socket.join('judge');
        socket.emit('joined-success', name);
        io.to('judge').emit('participant-list', Object.values(players));
        io.to('host').emit('judge-list', Object.values(players));
        console.log(`Judge created: ${name} (ID: ${judge.id})`);
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

    // Create new session with unique ID
    const sessionId = uuidv4();
    currentSession = await prisma.session.create({
      data: {
        name: `Session ${sessionId}`,
        sessionId: sessionId,
        teams: {
          create: teamNames.map(name => ({ name }))
        }
      }
    });
    
    // Run database migrations to apply schema changes
    await prisma.$executeRaw`PRAGMA foreign_keys=OFF`;
    await prisma.$executeRaw`PRAGMA foreign_keys=ON`;
    
    // Emit session created event with session ID
    socket.emit('session-created', { 
      sessionId,
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
      // Get full question details from database
      const questions = await prisma.question.findMany({
        where: { id: { in: questionIds.map(q => parseInt(q.id)) } }
      });
      
      console.log('Sending questions to judges:', questions);
      console.log('Current team:', teams[currentTeamIndex]);
      
      io.to('judge').emit('question', {
        questions,
        currentTeam: teams[currentTeamIndex]
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
    socket.emit('init-host-data', { 
      teams: teams.map(t => t.name),
      questions,
      questionBanks,
      sections: [...new Set(questions.map(q => q.section))]
    });
  });

  socket.on('save-questions', async ({questions, totalPoints, bankName}) => {
    try {
      let bank;
      if (bankName) {
        // Create or update question bank
        bank = await prisma.questionBank.upsert({
          where: { name: bankName },
          create: { name: bankName },
          update: {}
        });
        console.log('Bank created/updated:', bank);
      }

      if (currentSession) {
        // Update session with total points
        await prisma.session.update({
          where: { id: currentSession.id },
          data: { totalPoints: parseInt(totalPoints) }
        });

        // Delete existing questions for this session
        await prisma.question.deleteMany({
          where: { sessionId: currentSession.id }
        });
      }

      // Create new questions
      const createdQuestions = await prisma.$transaction(
        questions.map(q => prisma.question.create({
          data: {
            text: q.text,
            choices: q.choices,
            correct: q.correct,
            section: q.section,
            weight: q.weight,
            ...(currentSession && { session: { connect: { id: currentSession.id } }}),
            ...(bank && { 
              bank: { 
                connect: { id: bank.id }
              } 
            })
          }
        }))
      );
      console.log('Questions created:', createdQuestions.length, 'in bank:', bank?.name);

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
    } catch (error) {
      console.error('Error saving questions:', error);
      socket.emit('error-message', 'Failed to save questions');
    }
  });

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

  socket.on('next-team', () => {
    if (currentTeamIndex < teams.length - 1) {
      currentTeamIndex++;
      io.to('host').emit('team-changed', teams[currentTeamIndex]);
    }
  });

  socket.on('previous-team', () => {
    if (currentTeamIndex > 0) {
      currentTeamIndex--;
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

  socket.on('end-session', () => {
    io.to('judge').emit('session-ended');
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
        const savedAnswer = await prisma.answer.create({
          data: {
            answer: answerText,
            points: answerData.points || 0,
            question: { connect: { id: questionIndex + 1 } },
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

  async function saveTeamResult(sessionId, teamId, answers) {
    try {
      // Calculate total points
      const totalPoints = answers.reduce((sum, answer) => sum + (answer.points || 0), 0);
      
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
            answers: answers.map(a => ({
              questionText: a.question?.text,
              judgeName: a.judge?.name,
              answer: a.answer,
              points: a.points
            }))
          })
        },
        update: {
          totalPoints,
          details: JSON.stringify({
            answers: answers.map(a => ({
              questionText: a.question?.text,
              judgeName: a.judge?.name,
              answer: a.answer,
              points: a.points
            }))
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
