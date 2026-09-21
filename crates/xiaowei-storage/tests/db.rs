use std::sync::Arc;
use xiaowei_storage::{pb::*, Database};

fn statement(sql: &str) -> SqlStatement {
    SqlStatement {
        sql: sql.into(),
        ..Default::default()
    }
}

fn literal(kind: sql_value::Kind) -> SqlParameter {
    SqlParameter {
        source: Some(sql_parameter::Source::Literal(SqlValue { kind: Some(kind) })),
    }
}

#[tokio::test]
async fn values_columns_and_sql_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db.sqlite")).await.unwrap();
    let values = vec![
        sql_value::Kind::Null(Default::default()),
        sql_value::Kind::Integer(i64::MAX),
        sql_value::Kind::Real(1.25),
        sql_value::Kind::Text("中文\0🙂".into()),
        sql_value::Kind::Blob(vec![0, 255]),
        sql_value::Kind::Blob(vec![]),
    ];
    let result = db
        .query(SqlStatement {
            sql: "SELECT ? AS x,? AS x,?,?,?,?".into(),
            parameters: values.iter().cloned().map(literal).collect(),
            expected_rows: Some(1),
        })
        .await
        .unwrap();
    assert_eq!(&result.columns[..2], &["x", "x"]);
    assert_eq!(
        result.rows[0]
            .cells
            .iter()
            .map(|cell| cell.kind.clone().unwrap())
            .collect::<Vec<_>>(),
        values
    );
    for sql in [
        "BEGIN",
        "COMMIT",
        "SAVEPOINT a",
        "ATTACH ':memory:' AS other",
        "PRAGMA foreign_keys=OFF",
        "SELECT 1; SELECT 2",
        "SELECT ?",
        "SELECT load_extension('x')",
    ] {
        assert!(db.execute(statement(sql)).await.is_err(), "{sql}");
    }
    assert!(db.query(statement("CREATE TABLE forbidden(id INTEGER)")).await.is_err());
    let too_large = db.query(statement("SELECT zeroblob(5000000)")).await;
    assert!(too_large.is_err());
    db.close().await;
}

#[tokio::test]
async fn references_assertions_rollback_and_concurrent_writes() {
    let temp = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&temp.path().join("db.sqlite")).await.unwrap());
    db.execute(statement(
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)",
    ))
    .await
    .unwrap();
    let insert = statement("INSERT INTO items(value) VALUES('original') RETURNING id");
    let reference = SqlParameter {
        source: Some(sql_parameter::Source::Cell(SqlCellReference {
            step: 0,
            row: 0,
            column: 0,
        })),
    };
    let update = SqlStatement {
        sql: "UPDATE items SET value='changed' WHERE id=? RETURNING value".into(),
        parameters: vec![reference],
        expected_rows: Some(1),
    };
    let result = db
        .transaction(SqlTransaction {
            steps: vec![insert, update],
        })
        .await
        .unwrap();
    assert_eq!(
        result.results[1].rows[0].cells[0].kind,
        Some(sql_value::Kind::Text("changed".into()))
    );
    let mut fail = statement("SELECT id FROM items WHERE 0");
    fail.expected_rows = Some(1);
    assert!(db
        .transaction(SqlTransaction {
            steps: vec![statement("DELETE FROM items"), fail]
        })
        .await
        .is_err());
    assert_eq!(db.query(statement("SELECT id FROM items")).await.unwrap().rows.len(), 1);
    db.execute(statement("CREATE TABLE counter(n INTEGER NOT NULL)"))
        .await
        .unwrap();
    db.execute(statement("INSERT INTO counter VALUES(0)")).await.unwrap();
    let mut jobs = Vec::new();
    for _ in 0..20 {
        let db = db.clone();
        jobs.push(tokio::spawn(async move {
            db.transaction(SqlTransaction {
                steps: vec![
                    statement("SELECT n FROM counter"),
                    SqlStatement {
                        sql: "UPDATE counter SET n=?+1".into(),
                        parameters: vec![SqlParameter {
                            source: Some(sql_parameter::Source::Cell(SqlCellReference {
                                step: 0,
                                row: 0,
                                column: 0,
                            })),
                        }],
                        expected_rows: None,
                    },
                ],
            })
            .await
            .unwrap();
        }));
    }
    for job in jobs {
        job.await.unwrap();
    }
    assert_eq!(
        db.query(statement("SELECT n FROM counter")).await.unwrap().rows[0].cells[0].kind,
        Some(sql_value::Kind::Integer(20))
    );
    db.close().await;
}

#[tokio::test]
async fn cancelling_running_sql_rolls_back_and_releases_connections() {
    let temp = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&temp.path().join("db.sqlite")).await.unwrap());
    db.execute(statement("CREATE TABLE items(n INTEGER)")).await.unwrap();
    for _ in 0..6 {
        let work = db.clone();
        let job = tokio::spawn(async move {
            work.transaction(SqlTransaction {
                steps: vec![
                    statement("INSERT INTO items VALUES(1)"),
                    statement(
                        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL
                    SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n",
                    ),
                ],
            })
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        job.abort();
        let _ = job.await;
        let rows = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            db.query(statement("SELECT n FROM items")),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(rows.rows.is_empty());
    }
    tokio::time::timeout(std::time::Duration::from_secs(2), db.close())
        .await
        .unwrap();
}

#[tokio::test]
async fn conditional_merge_preserves_metadata_and_rolls_back_as_one_unit() {
    let temp = tempfile::tempdir().unwrap();
    let db = Database::open(&temp.path().join("db.sqlite")).await.unwrap();
    db.execute(statement(
        "CREATE TABLE entries(id INTEGER PRIMARY KEY, hash TEXT UNIQUE,
            favorite INTEGER, remark TEXT, category INTEGER)",
    ))
    .await
    .unwrap();
    db.execute(statement(
        "INSERT INTO entries VALUES(1,'source',1,'a',7),(2,'target',0,'b',NULL)",
    ))
    .await
    .unwrap();
    let merge = SqlTransaction {
        steps: vec![
            SqlStatement {
                expected_rows: Some(1),
                ..statement("SELECT favorite,remark,category FROM entries WHERE id=1")
            },
            SqlStatement {
                sql: "UPDATE entries SET favorite=favorite OR ?1,
                remark=CASE WHEN remark IS NULL THEN ?2 WHEN ?2 IS NULL OR remark=?2 THEN remark
                ELSE ?2||';'||remark END, category=coalesce(?3,category)
                WHERE hash='target' RETURNING id"
                    .into(),
                parameters: (0..3)
                    .map(|column| SqlParameter {
                        source: Some(sql_parameter::Source::Cell(SqlCellReference {
                            step: 0,
                            row: 0,
                            column,
                        })),
                    })
                    .collect(),
                expected_rows: Some(1),
            },
            statement("DELETE FROM entries WHERE id=1"),
        ],
    };
    let mut failing = merge.clone();
    failing.steps.push(statement("INSERT INTO missing_table VALUES(1)"));
    assert!(db.transaction(failing).await.is_err());
    assert_eq!(
        db.query(statement("SELECT id FROM entries")).await.unwrap().rows.len(),
        2
    );
    db.transaction(merge).await.unwrap();
    let result = db
        .query(statement("SELECT favorite,remark,category FROM entries"))
        .await
        .unwrap();
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0].cells[0].kind, Some(sql_value::Kind::Integer(1)));
    assert_eq!(result.rows[0].cells[1].kind, Some(sql_value::Kind::Text("a;b".into())));
    assert_eq!(result.rows[0].cells[2].kind, Some(sql_value::Kind::Integer(7)));
    db.close().await;
}
