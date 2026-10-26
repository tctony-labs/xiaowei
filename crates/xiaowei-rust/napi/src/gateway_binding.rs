// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_server_common_health_service {
    pub const CHECK: xw_gateway::binding::Method<(), proto_server_rs::xiaowei::server::common::BaseResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.common.Health.Check", xw_gateway::MethodKind::Unary);
    pub const READY: xw_gateway::binding::Method<(), proto_server_rs::xiaowei::server::common::BaseResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.common.Health.Ready", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_server_auth_auth_service {
    pub const LOGIN: xw_gateway::binding::Method<proto_server_rs::xiaowei::server::auth::LoginRequest, proto_server_rs::xiaowei::server::auth::LoginResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.auth.Auth.Login", xw_gateway::MethodKind::Unary);
    pub const REFRESH: xw_gateway::binding::Method<proto_server_rs::xiaowei::server::auth::RefreshRequest, proto_server_rs::xiaowei::server::auth::RefreshResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.auth.Auth.Refresh", xw_gateway::MethodKind::Unary);
    pub const GET_CURRENT_USER: xw_gateway::binding::Method<(), proto_server_rs::xiaowei::server::auth::GetCurrentUserResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.auth.Auth.GetCurrentUser", xw_gateway::MethodKind::Unary);
    pub const LOGOUT: xw_gateway::binding::Method<(), proto_server_rs::xiaowei::server::auth::LogoutResponse> =
        xw_gateway::binding::Method::new("xiaowei.server.auth.Auth.Logout", xw_gateway::MethodKind::Unary);
}
