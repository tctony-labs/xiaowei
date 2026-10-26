// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod testing_fixture_service {
    pub const ECHO: xw_gateway::binding::Method<proto_testing_rs::testing::Envelope, proto_testing_rs::testing::Envelope> =
        xw_gateway::binding::Method::new("testing.Fixture.Echo", xw_gateway::MethodKind::Unary);
    pub const WATCH: xw_gateway::binding::StreamMethod<proto_testing_rs::testing::Envelope, proto_testing_rs::testing::Changed> =
        xw_gateway::binding::StreamMethod::new("testing.Fixture.Watch");
}
#[rustfmt::skip]
pub mod testing_peer_fixture_service {
    pub const ECHO: xw_gateway::binding::Method<proto_testing_rs::testing::Envelope, proto_testing_rs::testing::Envelope> =
        xw_gateway::binding::Method::new("testing.PeerFixture.Echo", xw_gateway::MethodKind::Unary);
    pub const WATCH: xw_gateway::binding::StreamMethod<proto_testing_rs::testing::Envelope, proto_testing_rs::testing::Changed> =
        xw_gateway::binding::StreamMethod::new("testing.PeerFixture.Watch");
}
