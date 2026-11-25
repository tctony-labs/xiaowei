use flutter_rust_bridge::{for_generated::anyhow, frb};
use prost::Message;
use proto_server_rs::xiaowei::server::{
    AuthErrorCode, Authenticated, ErrorCode, LoginRequest, PasswordLogin, login_request,
};
use std::sync::Arc;
use xiaowei_mobile as mobile;

#[frb(sync)]
pub fn new_device_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[frb(sync)]
pub fn session_email(authenticated: Vec<u8>, device_id: String) -> anyhow::Result<String> {
    let session = Authenticated::decode(authenticated.as_slice())?;
    let user = session.user.filter(|user| !user.user_id.is_empty());
    let device = session
        .device
        .filter(|device| device.device_id == device_id);
    let tokens = session.tokens.filter(|tokens| {
        !tokens.session_id.is_empty()
            && !tokens.access_token.is_empty()
            && !tokens.refresh_token.is_empty()
    });
    match (user, device, tokens) {
        (Some(user), Some(_), Some(_)) => Ok(user.email),
        _ => Err(anyhow::anyhow!("Invalid stored account session")),
    }
}

#[derive(Clone)]
pub struct AccountContext {
    pub server: String,
    pub authenticated: Option<Vec<u8>>,
    pub connect: bool,
}

impl From<AccountContext> for mobile::SessionContext {
    fn from(value: AccountContext) -> Self {
        Self {
            server: value.server,
            authenticated: value.authenticated,
            connect: value.connect,
        }
    }
}

pub enum SessionAction {
    Restore,
    ForceRestore,
    Maintain,
    Logout,
    Revoke,
}

pub enum AccountResult {
    Success,
    InvalidCredentials,
    Unauthenticated,
    Unavailable,
}

pub struct AccountReply {
    pub result: AccountResult,
    pub authenticated: Option<Vec<u8>>,
    pub credential_version: u64,
    pub checkpoint: bool,
    pub next_maintenance_at_ms: i64,
}

impl From<mobile::AccountOutcome> for AccountReply {
    fn from(value: mobile::AccountOutcome) -> Self {
        let result = match value.code {
            code if code == ErrorCode::Success as i32 => AccountResult::Success,
            code if code == AuthErrorCode::InvalidCredentials as i32 => {
                AccountResult::InvalidCredentials
            }
            code if code == ErrorCode::Unauthenticated as i32 => AccountResult::Unauthenticated,
            _ => AccountResult::Unavailable,
        };
        Self {
            result,
            authenticated: value.authenticated,
            credential_version: value.credential_version,
            checkpoint: value.checkpoint,
            next_maintenance_at_ms: value.next_maintenance_at_ms,
        }
    }
}

#[frb(opaque)]
pub struct FlutterClient(Arc<mobile::MobileClient>);

impl FlutterClient {
    #[frb(sync)]
    pub fn open() -> anyhow::Result<Self> {
        Ok(Self(mobile::MobileClient::new()?))
    }

    pub async fn apply_session(&self, context: AccountContext) -> anyhow::Result<()> {
        self.0.set_session(context.into()).await?;
        Ok(())
    }

    #[frb(sync)]
    pub fn login(
        &self,
        context: AccountContext,
        email: String,
        password: String,
        device_id: String,
        device_name: String,
    ) -> anyhow::Result<FlutterOperation> {
        let request = LoginRequest {
            device_id,
            device_name,
            thirdparty_bind_token: None,
            credential: Some(login_request::Credential::Password(PasswordLogin {
                email,
                password,
            })),
        };
        Ok(FlutterOperation(
            self.0.login(context.into(), request.encode_to_vec())?,
        ))
    }

    #[frb(sync)]
    pub fn account(
        &self,
        context: AccountContext,
        action: SessionAction,
    ) -> anyhow::Result<FlutterOperation> {
        let context = context.into();
        let operation = match action {
            SessionAction::Restore => self.0.restore(context, false),
            SessionAction::ForceRestore => self.0.restore(context, true),
            SessionAction::Maintain => self.0.maintain(context, false),
            SessionAction::Logout => self.0.logout(context),
            SessionAction::Revoke => self.0.revoke(context),
        }?;
        Ok(FlutterOperation(operation))
    }

    #[frb(sync)]
    pub fn observe_connection(&self) -> anyhow::Result<FlutterConnection> {
        Ok(FlutterConnection(self.0.subscribe_connection()?))
    }

    pub async fn pause(&self) -> anyhow::Result<()> {
        Ok(self.0.suspend().await?)
    }

    pub async fn shutdown(&self) -> anyhow::Result<()> {
        Ok(self.0.close().await?)
    }
}

#[frb(opaque)]
pub struct FlutterOperation(Arc<mobile::AccountOperation>);

impl FlutterOperation {
    pub async fn run(&self) -> anyhow::Result<AccountReply> {
        Ok(self.0.run().await?.into())
    }

    pub async fn resume(&self, credential_version: u64) -> anyhow::Result<AccountReply> {
        Ok(self.0.resume(credential_version).await?.into())
    }

    #[frb(sync)]
    pub fn cancel(&self) {
        self.0.cancel();
    }

    pub async fn settle(&self) -> anyhow::Result<AccountReply> {
        Ok(self.0.settled_result().await?.into())
    }

    pub async fn shutdown(&self) -> anyhow::Result<()> {
        Ok(self.0.close().await?)
    }
}

pub enum LinkStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

pub struct LinkSnapshot {
    pub generation: u64,
    pub status: LinkStatus,
    pub rejected: bool,
}

#[frb(opaque)]
pub struct FlutterConnection(Arc<mobile::ConnectionSubscription>);

impl FlutterConnection {
    pub async fn next(&self) -> anyhow::Result<Option<LinkSnapshot>> {
        Ok(self.0.next().await?.map(|value| LinkSnapshot {
            generation: value.generation,
            status: match value.status {
                mobile::Status::Disconnected => LinkStatus::Disconnected,
                mobile::Status::Connecting => LinkStatus::Connecting,
                mobile::Status::Connected => LinkStatus::Connected,
                mobile::Status::Reconnecting => LinkStatus::Reconnecting,
            },
            rejected: value.authentication == Some(mobile::Authentication::Rejected),
        }))
    }

    #[frb(sync)]
    pub fn stop(&self) {
        self.0.close();
    }
}
