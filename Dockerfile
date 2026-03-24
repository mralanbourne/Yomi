FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# GITHUB LIMIT BYPASS (DOCKER FETCH)
RUN wget -O static/waiting.mp4 "https://github.com/mralanbourne/Yomi/releases/download/video/waiting.mp4"

EXPOSE 7000

CMD ["npm", "start"]
