use objc2::rc::autoreleasepool;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};
use std::path::Path;

/// Recognizes text in a local image using Vision. Call from a background thread.
pub fn recognize_text(path: &Path) -> Result<String, String> {
    autoreleasepool(|_| {
        let url = NSURL::from_file_path(path).ok_or("Invalid image path")?;
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        let chinese = NSString::from_str("zh-Hans");
        let english = NSString::from_str("en-US");
        request.setRecognitionLanguages(&NSArray::from_slice(&[&*chinese, &*english]));

        // An empty dictionary supplies no custom Vision image options.
        let handler = unsafe {
            VNImageRequestHandler::initWithURL_options(
                VNImageRequestHandler::alloc(),
                &url,
                &NSDictionary::new(),
            )
        };
        let requests = NSArray::<VNRequest>::from_slice(&[&request]);
        handler
            .performRequests_error(&requests)
            .map_err(|error| error.localizedDescription().to_string())?;

        let mut lines = Vec::new();
        if let Some(observations) = request.results() {
            for observation in &*observations {
                if let Some(candidate) = observation.topCandidates(1).firstObject() {
                    let text = candidate.string().to_string();
                    if !text.trim().is_empty() {
                        lines.push(text);
                    }
                }
            }
        }
        Ok(lines.join("\n"))
    })
}
