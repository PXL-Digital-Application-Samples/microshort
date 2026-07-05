# --- Build stage ---
FROM maven:3.9-eclipse-temurin-21 AS builder
WORKDIR /build

# Resolve dependencies first (layer cached unless pom.xml changes)
COPY pom.xml .
RUN mvn -B dependency:go-offline --no-transfer-progress

COPY src ./src
RUN mvn -B package -DskipTests --no-transfer-progress

# --- Runtime stage ---
FROM eclipse-temurin:21-jre-noble
WORKDIR /app

# curl is required for the compose healthcheck probe.
# eclipse-temurin:21-jre-noble (Ubuntu 24.04) does not ship curl by default.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system appgroup && \
    useradd --system --gid appgroup --no-create-home appuser

COPY --from=builder /build/target/analytics-service-*.jar app.jar

USER appuser
EXPOSE 3005
ENTRYPOINT ["java", "-jar", "app.jar"]
