use evalexpr::{eval_with_context, ContextWithMutableVariables, HashMapContext, Value};

/// 黄金比例 φ = (1 + √5) / 2。
const PHI: f64 = 1.618_033_988_749_895;

/// 构造带内置数学常量的求值上下文。
///
/// `evalexpr` 默认不注入常量，只把 `pi` / `e` / `phi` 当未定义变量，因此这里显式注册。
/// 为兼容常见大小写写法，同时注册小写与大写两种标识符。
fn build_context() -> HashMapContext {
    let mut ctx = HashMapContext::new();
    for (name, value) in [("pi", std::f64::consts::PI), ("e", std::f64::consts::E), ("phi", PHI)] {
        let _ = ctx.set_value(name.to_string(), Value::Float(value));
        let _ = ctx.set_value(name.to_uppercase(), Value::Float(value));
    }
    ctx
}

fn trim_query(query: &str) -> String {
    let trimmed = query.trim();
    if let Some(idx) = trimmed.rfind('=') {
        let tail = trimmed[idx..].trim();
        if tail == "=" {
            return trimmed[..idx].trim().to_string();
        }
    }
    trimmed.to_string()
}

/// 仅当表达式求值结果为数字（整数 / 浮点）时返回其字符串表示。
///
/// 布尔、字符串、元组、空值等一律视为「非计算结果」返回 `None`，避免把带引号的
/// 字符串字面量、逻辑判断等普通输入回显成搜索结果。
fn try_evaluate(expr: &str) -> Option<String> {
    let value = eval_with_context(expr, &build_context()).ok()?;
    match value {
        evalexpr::Value::Int(n) => Some(n.to_string()),
        evalexpr::Value::Float(f) => {
            if !f.is_finite() {
                return None;
            }
            if (f - f.round()).abs() < f64::EPSILON && f.abs() < i64::MAX as f64 {
                Some(format!("{}", f.round() as i64))
            } else {
                Some(f.to_string())
            }
        }
        _ => None,
    }
}

/// 判定是否当作计算表达式：不做「必须含数字」之类的启发式拦截，只要能求出数字即可。
///
/// 仅保留两条最小护栏：空串直接跳过；纯数字（如 `42`、`3.14`）没有计算意义，避免
/// 回显成 `42 = 42` 污染结果。其余「像不像算式」完全交给 `evalexpr` 求值：未定义
/// 标识符会报错，因此 `hello`、`report` 等普通输入不会被误判。
fn looks_like_calculation(query: &str) -> bool {
    let expr = trim_query(query);
    if expr.is_empty() {
        return false;
    }
    if expr.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return false;
    }
    try_evaluate(&expr).is_some()
}

pub fn calculate(query: &str) -> Option<(String, String)> {
    if !looks_like_calculation(query) {
        return None;
    }
    let expr = trim_query(query);
    let result = try_evaluate(&expr)?;
    Some((format!("{expr} = {result}"), result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculator_basic() {
        assert_eq!(try_evaluate("1+2"), Some("3".into()));
        assert_eq!(trim_query("1+2="), "1+2");
    }

    #[test]
    fn calculator_rejects_plain_number() {
        assert!(!looks_like_calculation("42"));
    }

    #[test]
    fn calculator_accepts_expression() {
        assert!(looks_like_calculation("(1+2)*3"));
    }

    #[test]
    fn calculator_supports_constants() {
        assert_eq!(try_evaluate("pi"), Some(std::f64::consts::PI.to_string()));
        assert_eq!(try_evaluate("e"), Some(std::f64::consts::E.to_string()));
        assert_eq!(try_evaluate("phi"), Some(PHI.to_string()));
        // 大写写法同样可用。
        assert_eq!(try_evaluate("PI"), Some(std::f64::consts::PI.to_string()));
    }

    #[test]
    fn calculator_constants_in_expression() {
        assert_eq!(try_evaluate("2*pi"), Some((2.0 * std::f64::consts::PI).to_string()));
    }

    #[test]
    fn calculator_accepts_digitless_expression() {
        // 不含数字的常量 / 函数表达式现在也应被识别为计算。
        assert!(looks_like_calculation("math::sin(pi)"));
        assert!(looks_like_calculation("pi*e"));
    }

    #[test]
    fn calculator_rejects_non_numeric_result() {
        // 布尔、字符串等非数字结果不展示。
        assert!(!looks_like_calculation("true && false"));
        assert!(!looks_like_calculation("\"ab\" + \"cd\""));
    }

    #[test]
    fn calculator_rejects_plain_words() {
        // 未定义标识符求值失败，普通输入不会被误判为计算。
        assert!(!looks_like_calculation("hello"));
        assert!(!looks_like_calculation("hello world"));
    }
}
