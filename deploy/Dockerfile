FROM golang:1.26.5 AS build
WORKDIR /src
COPY server/go.mod ./
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /xiaowei-server ./cmd/xiaowei-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /xiaowei-server /xiaowei-server
ENV XIAOWEI_LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/xiaowei-server"]
