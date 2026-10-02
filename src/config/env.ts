import dotenv from 'dotenv';
dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '5000', 10),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://postgres:pass1234@localhost:5432/FleetDB',
  arcjetKey: process.env.ARCJET_KEY || '',
};
