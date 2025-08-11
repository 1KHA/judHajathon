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

  // No demo questions or banks will be seeded.

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

    // No question banks or questions are seeded. Only teams (if any) are created.
    console.log('Successfully seeded demo teams! (No questions or banks)');
  } catch (error) {
    console.error('Error seeding teams and questions:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seedTeams();
