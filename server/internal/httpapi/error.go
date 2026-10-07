package httpapi

import (
	"net/http"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"google.golang.org/protobuf/encoding/protojson"
)

func writeProtocolError(w http.ResponseWriter, code int32, message string) {
	recordResponseCode(w, code)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	body, _ := (protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}).Marshal(&pb.ErrorResponse{
		Code: code, Msg: message,
	})
	_, _ = w.Write(body)
}
