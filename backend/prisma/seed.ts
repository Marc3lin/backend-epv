import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("SenhaADM123", 12);

  await prisma.user.upsert({
    where: { email: "vinicius@arenaepv.local" },
    update: {},
    create: {
      email: "vinicius@arenaepv.local",
      fullName: "Vinicius",
      passwordHash,
      role: Role.ADMIN,
      mustChangePass: true
    }
  });

  await prisma.user.upsert({
    where: { email: "sabrina@arenaepv.local" },
    update: {},
    create: {
      email: "sabrina@arenaepv.local",
      fullName: "Sabrina",
      passwordHash,
      role: Role.ADMIN,
      mustChangePass: true
    }
  });

  await prisma.user.upsert({
    where: { email: "recepcao@arenaepv.local" },
    update: {},
    create: {
      email: "recepcao@arenaepv.local",
      fullName: "Recepção",
      passwordHash,
      role: Role.RECEPTION,
      mustChangePass: true
    }
  });

  const courts = [
    {
      slug: "areia-1",
      name: "Vôlei de Areia 1",
      type: "SAND_VOLLEY" as const,
      description: "Quadra de areia 1 para vôlei de areia, treinos, jogos e eventos.",
      sports: ["Vôlei de Areia 1"]
    },
    {
      slug: "areia-2",
      name: "Vôlei de Areia 2",
      type: "SAND_VOLLEY" as const,
      description: "Quadra de areia 2 para vôlei de areia, reservas paralelas e torneios.",
      sports: ["Vôlei de Areia 2"]
    },
    {
      slug: "piso-volei",
      name: "Vôlei de Quadra",
      type: "INDOOR_VOLLEY" as const,
      description: "Quadra de piso dedicada ao vôlei de quadra.",
      sports: ["Vôlei de Quadra"]
    },
    {
      slug: "piso-multi",
      name: "Futsal / Vôlei de Quadra",
      type: "MULTI" as const,
      description: "Quadra de piso multiuso preparada para futsal e vôlei de quadra, com preço conforme a modalidade escolhida.",
      sports: ["Futsal", "Vôlei de Quadra"]
    }
  ];

  for (const court of courts) {
    await prisma.court.upsert({
      where: { slug: court.slug },
      update: court,
      create: court
    });
  }
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
