# Front end built with Vite; the server runs its TypeScript natively on Node 24.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 API_PORT=5174
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
# Analysis, tempo and universe corrections persist here.
VOLUME /app/.cache
EXPOSE 5174
USER node
CMD ["node", "server/main.ts"]
