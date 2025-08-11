const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedTeams() {
  const demoTeams = [
    'Team Alpha',
    'Team Bravo', 
    'Team Charlie',
    'Team Delta',
    'Team Echo'
  ];

  const demoQuestions = [
    {
      text: 'q1',
      choices: [
        { text: 'a1', weight: 1 },
        { text: 'a2', weight: 2 },
        { text: 'a3', weight: 3 },
        { text: 'a4', weight: 4 }
      ],
      correct: 'a2',
      section: 'Section 1',
      weight: 2
    },
    {
      text: 'q2',
      choices: [
        { text: 'b1', weight: 1 },
        { text: 'b2', weight: 2 },
        { text: 'b3', weight: 3 },
        { text: 'b4', weight: 4 }
      ],
      correct: 'b3',
      section: 'Section 2',
      weight: 3
    }
  ];

  try {
    console.log('Seeding demo teams and questions...');
    
    // Create global teams (no session association)
    for (const teamName of demoTeams) {
      await prisma.team.create({
        data: {
          name: teamName
        }
      });
      console.log(`Created team: ${teamName}`);
    }

    // Create global questions (no session association)
    for (const question of demoQuestions) {
      await prisma.question.create({
        data: {
          text: question.text,
          choices: question.choices,
          correct: question.correct,
          section: question.section,
          weight: question.weight
        }
      });
      console.log(`Created question: ${question.text}`);
    }

    console.log('Successfully seeded global demo teams and questions!');
  } catch (error) {
    console.error('Error seeding teams and questions:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seedTeams();
