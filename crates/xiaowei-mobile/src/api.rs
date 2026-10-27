use crate::{MobileError, Result, runtime};
use prost::Message;
use proto_server_rs::xiaowei::server::BaseResponse;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

struct State {
    closed: bool,
    task: Option<runtime::Task<Vec<u8>>>,
}

pub struct ApiCall {
    pub(crate) work: Arc<ApiWork>,
}

pub(crate) struct ApiWork {
    api: Arc<xw_api::Client>,
    method: String,
    payload: Vec<u8>,
    context: xw_api::RequestContext,
    state: Mutex<State>,
    finished: Arc<AtomicBool>,
}

impl ApiCall {
    pub(crate) fn new(
        api: Arc<xw_api::Client>,
        method: String,
        payload: Vec<u8>,
        context: xw_api::RequestContext,
    ) -> Arc<Self> {
        Arc::new(Self {
            work: Arc::new(ApiWork {
                api,
                method,
                payload,
                context,
                state: Mutex::new(State {
                    closed: false,
                    task: None,
                }),
                finished: Arc::new(AtomicBool::new(false)),
            }),
        })
    }

    pub async fn run(&self) -> Result<Vec<u8>> {
        self.work.run().await
    }

    pub fn cancel(&self) {
        self.work.cancel();
    }

    pub async fn close(&self) {
        self.work.close().await;
    }
}

impl ApiWork {
    async fn run(&self) -> Result<Vec<u8>> {
        let task = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return Err(MobileError::closed());
            }
            if state.task.is_none() {
                let api = self.api.clone();
                let method = self.method.clone();
                let payload = self.payload.clone();
                let mut context = self.context.clone();
                context.now_ms = xw_api::now_ms();
                let finished = self.finished.clone();
                state.task = Some(runtime::spawn(async move {
                    let result = match api.invoke(&method, &payload, &context).await {
                        Ok(bytes) => Ok(bytes),
                        // As in the desktop adapter, restore the shared failure PB envelope.
                        Err(error) if error.category == "business" => Ok(BaseResponse {
                            code: error.code,
                            msg: error.message,
                            data: None,
                        }
                        .encode_to_vec()),
                        Err(error) => Err(error.into()),
                    };
                    finished.store(true, Ordering::Release);
                    result
                })?);
            }
            state.task.clone().unwrap()
        };
        task.await
    }

    pub(crate) fn cancel(&self) {
        self.context.cancellation.cancel();
    }

    pub(crate) async fn close(&self) {
        let task = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            self.cancel();
            state.task.clone()
        };
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    pub(crate) fn finished(&self) -> bool {
        if self.finished.load(Ordering::Acquire) {
            return true;
        }
        let state = self.state.lock().unwrap();
        match &state.task {
            Some(_) => false,
            None => state.closed || self.context.cancellation.is_cancelled(),
        }
    }
}

impl Drop for ApiCall {
    fn drop(&mut self) {
        self.cancel();
    }
}
