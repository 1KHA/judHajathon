const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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

    // Create new session
    currentSession = await prisma.session.create({
      data: {
        name: `Session ${new Date().toISOString()}`,
        teams: {
          create: teamNames.map(name => ({ name }))
        }
      }
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
    // Send existing teams and questions to host
    const teams = await prisma.team.findMany({
      distinct: ['name'],
      select: { name: true }
    });
    const questions = await prisma.question.findMany({
      distinct: ['text'],
      select: { id: true, text: true }
    });
    socket.emit('init-host-data', { 
      teams: teams.map(t => t.name),
      questions 
    });
  });

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
          question: { connect: { id: questionIndex + 1 } },
          team: { connect: { id: team.id } },
          judge: { connect: { id: judge.id } },
          session: { connect: { id: currentSession.id } }
        }
      });
      console.log('Answer saved:', savedAnswer);
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
      answer: answerText
    });
    
    io.to('host').emit('answers-updated', answersByTeam);
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.to('judge').emit('participant-list', Object.values(players));
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
