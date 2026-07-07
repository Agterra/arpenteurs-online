import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'

function createClient() {
  const connectionString = process.env.NUXT_DATABASE_URL || process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
}

// Cache on globalThis so Nitro dev reloads don't exhaust the connection pool.
const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient }

export const db: PrismaClient = globalForPrisma.__prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.__prisma = db
