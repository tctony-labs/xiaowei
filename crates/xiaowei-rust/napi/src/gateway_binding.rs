// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_server_health_service {
    pub const CHECK: xw_gateway::binding::Method<(), proto_server_rs::xiaowei::server::BaseResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.Health.Check", xw_gateway::MethodKind::Unary);
    pub const READY: xw_gateway::binding::Method<(), proto_server_rs::xiaowei::server::BaseResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.Health.Ready", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_server_auth_service {
    pub const LOGIN: xw_gateway::binding::Method<proto_server_rs::xiaowei::server::LoginRequest, proto_server_rs::xiaowei::server::LoginResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.Auth.Login", xw_gateway::MethodKind::Unary);
    pub const REFRESH: xw_gateway::binding::Method<proto_server_rs::xiaowei::server::RefreshRequest, proto_server_rs::xiaowei::server::RefreshResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.Auth.Refresh", xw_gateway::MethodKind::Unary);
    pub const GET_CURRENT_USER: xw_gateway::binding::Method<(), proto_server_rs::xiaowei::server::GetCurrentUserResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.Auth.GetCurrentUser", xw_gateway::MethodKind::Unary);
    pub const LOGOUT: xw_gateway::binding::Method<(), proto_server_rs::xiaowei::server::LogoutResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.Auth.Logout", xw_gateway::MethodKind::Unary);
}
