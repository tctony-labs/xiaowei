// Package main is an independent consumer of the generated contract package.
package main

import (
	"io"
	"os"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/testing"
	auth "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"google.golang.org/protobuf/proto"
)

func main() {
	file := pb.File_testing_fixture_proto
	service := file.Services().ByName("Fixture")
	echo := service.Methods().ByName("Echo")
	watch := service.Methods().ByName("Watch")
	if echo.Input().FullName() != "testing.Envelope" ||
		echo.Output().FullName() != "testing.Envelope" || echo.IsStreamingServer() ||
		watch.Input().FullName() != "testing.Envelope" ||
		watch.Output().FullName() != "testing.Changed" || !watch.IsStreamingServer() ||
		file.Messages().ByName("Changed").FullName() != "testing.Changed" {
		panic("contract descriptor mismatch")
	}
	input, err := io.ReadAll(os.Stdin)
	if err != nil {
		panic(err)
	}
	var value proto.Message = new(pb.Envelope)
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "login-request":
			value = new(auth.LoginRequest)
		case "login-response":
			value = new(auth.LoginResponse)
		default:
			panic("unknown codec mode")
		}
	}
	if err := proto.Unmarshal(input, value); err != nil {
		panic(err)
	}
	output, err := proto.Marshal(value)
	if err != nil {
		panic(err)
	}
	if _, err := os.Stdout.Write(output); err != nil {
		panic(err)
	}
}
