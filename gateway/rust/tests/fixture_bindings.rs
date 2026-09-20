// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod testing_fixture_service {
    pub const ECHO: xw_gateway::binding::Method<xw_contracts::testing::Envelope, xw_contracts::testing::Envelope> =
        xw_gateway::binding::Method::new("testing.Fixture.Echo", xw_gateway::MethodKind::Unary);
    pub const WATCH: xw_gateway::binding::StreamMethod<xw_contracts::testing::Envelope, xw_contracts::testing::Changed> =
        xw_gateway::binding::StreamMethod::new("testing.Fixture.Watch");
}
#[rustfmt::skip]
pub mod testing_peer_fixture_service {
    pub const ECHO: xw_gateway::binding::Method<xw_contracts::testing::Envelope, xw_contracts::testing::Envelope> =
        xw_gateway::binding::Method::new("testing.PeerFixture.Echo", xw_gateway::MethodKind::Unary);
    pub const WATCH: xw_gateway::binding::StreamMethod<xw_contracts::testing::Envelope, xw_contracts::testing::Changed> =
        xw_gateway::binding::StreamMethod::new("testing.PeerFixture.Watch");
}
