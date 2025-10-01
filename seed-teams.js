const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// List of teams to seed
const teams = [
  { name: 'فريق الابتكار' },
  { name: 'فريق التميز' },
  { name: 'فريق الإبداع' },
  { name: 'فريق النجاح' },
  { name: 'فريق التحدي' },
  { name: 'فريق الريادة' },
  { name: 'فريق المستقبل' },
  { name: 'فريق الأمل' },
  { name: 'فريق الطموح' },
  { name: 'فريق الإنجاز' }
];

async function seedTeams() {
  console.log('Starting to seed teams...');
  
  try {
    // Create teams
    const createdTeams = await Promise.all(
      teams.map(async (team) => {
        // Use upsert to avoid duplicates
        const createdTeam = await prisma.team.upsert({
          where: { name: team.name },
          update: {},
          create: team
        });
        return createdTeam;
      })
    );
    
    console.log(`Successfully seeded ${createdTeams.length} teams:`);
    createdTeams.forEach(team => {
      console.log(`- ${team.name} (ID: ${team.id})`);
    });
  } catch (error) {
    console.error('Error seeding teams:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the seed function
seedTeams()
  .then(() => {
    console.log('Seeding completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error during seeding:', error);
    process.exit(1);
  });
