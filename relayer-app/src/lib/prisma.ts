import { PrismaClient } from "../generated/prisma";

// Augment the NodeJS global type with our PrismaClient instance
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

let prismaInstance: PrismaClient;

if (process.env.NODE_ENV === "production") {
  prismaInstance = new PrismaClient({
    log: ["error"],
  });
} else {
  if (!global.prisma) {
    global.prisma = new PrismaClient({
      log: ["error"],
    });
  }
  prismaInstance = global.prisma;
}

export const prisma = prismaInstance;
