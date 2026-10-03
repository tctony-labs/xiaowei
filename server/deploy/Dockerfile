FROM golang:1.26.5 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -o /xiaowei-server ./cmd/xiaowei-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /xiaowei-server /xiaowei-server
EXPOSE 10001
ENTRYPOINT ["/xiaowei-server"]
