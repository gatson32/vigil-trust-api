# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if exists)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the bot code
COPY bot.js .
COPY register-commands.js .

# Set environment to production
ENV NODE_ENV=production

# Run the bot
CMD ["node", "bot.js"]
