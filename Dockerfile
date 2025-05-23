# Use the official Node.js image as the base image
FROM node:22-alpine

# Set the working directory
WORKDIR /attendance-app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies in production mode
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["npm", "start"]