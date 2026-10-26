FROM --platform=$BUILDPLATFORM golang:1.26.5 AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
COPY contracts/out/proto-server-go /src/contracts/out/proto-server-go
RUN go mod download
COPY server/cmd ./cmd
COPY server/internal ./internal
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -o /xiaowei-server ./cmd/xiaowei-server
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -o /xiaowei-healthcheck ./cmd/xiaowei-healthcheck

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /xiaowei-server /xiaowei-server
COPY --from=build /xiaowei-healthcheck /xiaowei-healthcheck
EXPOSE 10001
ENTRYPOINT ["/xiaowei-server"]
