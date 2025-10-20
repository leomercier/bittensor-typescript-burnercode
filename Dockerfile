FROM node:24-slim

RUN apt-get update

WORKDIR /usr/src/app

COPY src ./src
COPY *.json ./

RUN npm install

RUN npm ci

EXPOSE 8080

CMD ["npm", "start"]
