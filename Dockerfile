# Etapa 1: Build da aplicação
FROM node:20-alpine AS builder

# Define o diretório de trabalho
WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala as dependências (incluindo devDependencies para o build)
RUN npm install

# Copia o restante do código
COPY . .

# Executa o build da aplicação NestJS
RUN npm run build

# Etapa 2: Imagem final para produção
FROM node:20-alpine

WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala apenas as dependências de produção
RUN npm install --only=production

# Copia a pasta dist gerada no stage anterior
COPY --from=builder /app/dist ./dist

# Expõe a porta que a aplicação usa (ajuste se necessário)
EXPOSE 3000

# Comando para iniciar a aplicação
CMD ["node", "dist/main"]
