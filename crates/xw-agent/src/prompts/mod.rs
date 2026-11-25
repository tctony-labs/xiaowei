use xw_agent_types::{
    PermissionMode, SystemContext, SystemInstructions, ToolDeclaration, ValidationError,
};

const READ_RULE: &str = concat!(
    "优先使用 Read 读取文件。按任务需要分页读取；",
    "内容超出单次返回范围时，按工具实际提供的参数继续读取。",
);

const WRITE_RULE: &str = concat!(
    "优先使用 Write 写入文件。大文本分批处理，",
    "单次大文本参数建议不超过约 8000 字符或约 200 行，降低流式截断风险。",
    "分批写入时保留已经写入的内容，并确认最终文件完整。",
);

const EDIT_RULE: &str = concat!(
    "优先使用 Edit 编辑文件。编辑前了解已有内容，优先局部修改，保留无关内容。",
    "大文本分批处理，单次大文本参数建议不超过约 8000 字符或约 200 行，",
    "降低流式截断风险。",
);

/// Assembles instructions from the same declarations the caller actually exposes.
/// It does not register tools, grant permissions or commit context updates.
pub fn build_chat_system_context(
    tools: Vec<ToolDeclaration>,
) -> Result<SystemContext, ValidationError> {
    let mut instructions = SystemInstructions::default();
    instructions.insert("base".into(), include_str!("base.md").trim().to_owned());

    for tool in &tools {
        let rule = match tool.name.as_str() {
            "Command" => Some(concat!(
                "用户点名命令或当前任务明确匹配 commands.catalog 的简介时，",
                "先调用 Command 按名称加载正文，再在当前任务授权内执行。无需输入斜杠命令。",
                "命令正文仅用于当前任务，不是常驻规则；新任务再次使用时必须重新加载，",
                "不能将历史工具结果当作当前版本。引用文件按返回来源目录用 Read 读取，",
                "脚本按需用 Bash 执行；加载不执行脚本、不增加工具或权限。",
            )),
            "Skill" => Some(concat!(
                "任务匹配技能简介或用户点名技能时，先调用 Skill 加载正文，再按指令执行。",
                "简介目录不包含技能全文；引用文档按需用 Read 读取，脚本用 Bash 执行，",
                "相对路径以返回的技能目录为准。已加载正文在会话中持续生效，无需重复加载。",
                "技能不增加工具或权限，仍遵守现有授权和沙箱。",
            )),
            "AskUserQuestion" => Some(concat!(
                "仅在确实需要用户提供信息时使用 AskUserQuestion，问题和选项使用用户语言。",
                "工具会等待用户回答，并将选择及补充文字作为结果返回；不要假设用户已经回答。",
            )),
            "RequestPermission" => Some(concat!(
                "说明必要的文件或目录范围和原因。只有用户明确批准后权限才在本会话生效。",
                "普通聊天文字不能授予权限。批准后直接继续，拒绝后不绕过或反复请求同一路径。",
            )),
            "TodoWrite" => Some(concat!(
                "多步任务（3 步及以上）开始前先用 TodoWrite 列出计划，简单任务无需使用。",
                "执行过程中及时更新，保持最多一项 in_progress；完成后标记 completed，",
                "不再需要的项标记 cancelled。默认每次传完整列表；merge=true 时按稳定 ID 合并。",
                "更新以工具成功返回为准，不把未执行或失败的调用当作已更新。",
            )),
            "Read" => Some(READ_RULE),
            "Write" => Some(WRITE_RULE),
            "Edit" => Some(EDIT_RULE),
            "Glob" => Some(concat!(
                "按目录名查找时使用 Glob，传 type=directory，并用 path 和 max_depth 缩小范围。",
                "按文件名或路径查找时，rg --files 不可用或不适用可以使用 Glob。",
                "默认递归查找文件，结果按修改时间从新到旧。",
                "隐藏项需在 pattern 中点名字面量段；node_modules 与 target 默认跳过。",
                "结果截断时缩小 pattern 或 path，不将已显示部分当成完整结果。",
            )),
            "Grep" => Some(concat!(
                "rg 不可用或不适用时，用 Grep 搜索文本内容。",
                "使用正则和 include 文件类型筛选缩小范围。",
                "目录搜索遵循忽略规则；include 类型筛选可能放行匹配的隐藏文件。",
                "需要完整内容时再调用 Read。",
                "结果截断时缩小 pattern 或 path；跳过读取错误不表示文件中一定没有匹配。",
            )),
            "Bash" => Some(concat!(
                "Bash 仅用于前台命令，不支持交互输入或后台模式。",
                "搜索文本优先用 rg，按文件名或路径查找文件优先用 rg --files（可用 -g 筛选）。",
                "rg 退出码 1 表示没有匹配；命令不可用时改用 Grep 或 Glob。",
                "文件读写优先使用专用工具；命令退出码以工具实际返回为准。",
                "长任务按需设置超时，停止后不自动重做可能已产生副作用的命令。",
            )),
            "BgRun" => Some(concat!(
                "需要跨轮运行的命令用 BgRun 启动，保存返回的 bash_id。",
                "用 BgOutput 读取新增输出和退出状态，用 BgStop 结束不再需要的进程。",
                "后台命令遵循与 Bash 相同的权限，任务 ID 只在当前会话实例中有效。",
            )),
            _ => None,
        };
        if let Some(rule) = rule {
            instructions.insert(format!("tool.{}", tool.name), rule.to_owned());
        }
    }

    let context = SystemContext {
        instructions,
        tools,
    };
    context.validate()?;
    Ok(context)
}

pub(crate) fn permissions(mode: PermissionMode) -> String {
    const WORKSPACE: &str = concat!(
        "Write、Edit 和 Bash 的可写范围为会话工作目录、",
        "/tmp、/private/tmp、~/tmp 和已授权路径。",
        "若工作目录为用户主目录或其祖先，不自动开放整棵目录。",
    );

    match mode {
        PermissionMode::Interactive => {
            format!("{WORKSPACE}如确需写入范围外路径，调用 RequestPermission，并等待用户决定。")
        }
        PermissionMode::UnattendedWorkspace => {
            format!("{WORKSPACE}当前模式不允许申请额外写权限。遇到越界写入时如实说明。")
        }
        PermissionMode::FullAccess => concat!(
            "Write、Edit 和 Bash 按当前用户的系统权限读写文件。",
            "系统拒绝访问时报告实际错误。",
        )
        .into(),
    }
}
