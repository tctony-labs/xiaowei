import Foundation
import ProtoServer

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let output: Data
    switch CommandLine.arguments.dropFirst().first {
    case "login-request":
        output = try Xiaowei_Server_Auth_LoginRequest(serializedBytes: input).serializedData()
    case "login-response":
        output = try Xiaowei_Server_Auth_LoginResponse(serializedBytes: input).serializedData()
    case "base-response":
        output = try Xiaowei_Server_Common_BaseResponse(serializedBytes: input).serializedData()
    default:
        throw CocoaError(.coderInvalidValue)
    }
    FileHandle.standardOutput.write(output)
} catch {
    FileHandle.standardError.write(Data("Contract decode failed\n".utf8))
    exit(1)
}
