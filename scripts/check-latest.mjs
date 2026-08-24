import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const latest = await prisma.assessment.findMany({
  orderBy: { id: "desc" },
  take: 3,
  include: { facts: true, journeyOverviewContent: true },
});
for (const a of latest) {
  console.log("===", a.id.toString(), a.customerId, "===");
  console.log("sourceReports:", [...new Set(a.facts.map((f) => f.sourceReport))]);
  console.log("journeyOverviewContent:", a.journeyOverviewContent);
  const codeValueFact = a.facts.find((f) => f.label === "Past Experiences - Code/Value");
  const noteBalanceFact = a.facts.find((f) => f.label === "Note Balance - values");
  console.log("Code/Value fact:", codeValueFact ? codeValueFact.value : "MISSING");
  console.log("Note Balance fact:", noteBalanceFact ? noteBalanceFact.value : "MISSING");
}
await prisma.$disconnect();
