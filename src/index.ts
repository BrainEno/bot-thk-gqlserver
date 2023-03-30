import "reflect-metadata";
import { buildApp } from "./app";
import dotenv from "dotenv";
import mongoose from "mongoose";

const main = async () => {
  dotenv.config();
  const port = parseInt(process.env.PORT!, 10) || 4001;
  const app = buildApp();
  try {
    mongoose
      .connect(process.env.MONGODB_URI!)
      .then(() => console.log("***MongoDB connected***"));
  } catch (error) {
    console.log("Error connecting to MongoDB:", error?.message);
  }

  try {
    await new Promise((resolve) => app.listen({ port }, resolve as any));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  console.log(`🚀 Apollo server ready at http://localhost:${port}/graphql`);
};

main()