# 빌드: 화면(dist)을 만든다
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

# 실행: 의존성 없이 Node 내장 모듈만 쓰는 서버(server/prod.ts)와 dist만 담는다
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY server/prod.ts server/accessCode.ts ./server/
COPY package.json ./
RUN chmod -R a+rX /app
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "server/prod.ts"]
