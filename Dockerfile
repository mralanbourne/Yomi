  yomi-scraper:
    image: "ghcr.io/mralanbourne/yomi:latest"
    container_name: "stremio-yomi"
    restart: "unless-stopped"
    env_file:
      - ".env"
    environment:
      - "NODE_ENV=production"
      - "PORT=7000"
    networks:
      - "stremio-network"
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
