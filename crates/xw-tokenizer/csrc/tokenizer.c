#include <stdio.h>
#include <string.h>

#include "sqlite3.h"
#include "sqlite3ext.h"

#ifndef UNUSED_PARAM
#define UNUSED_PARAM(X) (void)(X)
#endif

// -----------------------------------------------------------------------------

#ifndef SQLITE_CORE
SQLITE_EXTENSION_INIT1
#endif

/*
** Return a pointer to the fts5_api pointer for database connection db.
** If an error occurs, return NULL and leave an error in the database
** handle (accessible using sqlite3_errcode()/errmsg()).
*/
fts5_api *fts5_api_from_db(sqlite3 *db) {
  fts5_api *pRet = 0;
  sqlite3_stmt *pStmt = 0;

  if (SQLITE_OK == sqlite3_prepare(db, "SELECT fts5(?1)", -1, &pStmt, 0)) {
    sqlite3_bind_pointer(pStmt, 1, (void *)&pRet, "fts5_api_ptr", NULL);
    sqlite3_step(pStmt);
  }
  sqlite3_finalize(pStmt);

  return pRet;
}

// -----------------------------------------------------------------------------

typedef struct XiaoWeiTokenizer XiaoWeiTokenizer;
struct XiaoWeiTokenizer {
  int type; // 1 standard, 2 character
};

/*
** Create a tokenizer.
*/
static int xiaoweiCreate(void *pUnused, const char **azArg, int nArg,
                          Fts5Tokenizer **ppOut) {
  int rc = SQLITE_OK;
  XiaoWeiTokenizer *p = 0;
  UNUSED_PARAM(pUnused);

  // currently only accept a type parameter which is:
  //   std or char, default to std
  if (nArg > 1 || (nArg == 1 && (strcmp(azArg[0], "std") != 0 &&
                              strcmp(azArg[0], "char") != 0))) {
    rc = SQLITE_ERROR;
  } else {
    p = sqlite3_malloc(sizeof(XiaoWeiTokenizer));
    if (p == 0) {
      rc = SQLITE_NOMEM;
    } else {
      memset(p, 0, sizeof(XiaoWeiTokenizer));

      p->type = 1; // std
      if (nArg > 0 && strcmp(azArg[0], "char") == 0) {
        p->type = 2; // char
      }
    }
  }

  *ppOut = (Fts5Tokenizer *)p;
  return rc;
}

/*
** Delete a tokenizer.
*/
static void xiaoweiDelete(Fts5Tokenizer *p) { sqlite3_free(p); }

int tokenize_impl(void *tokenizer, void *pCtx, int flags, const char *pText,
                  int nText,
                  int (*tokenCallback)(void *, int, const char *, int nToken,
                                       int iStart, int iEnd));

/*
** Tokenize some text using the xiaowei tokenizer.
*/
static int xiaoweiTokenize(Fts5Tokenizer *pTokenizer, void *pCtx, int flags,
                           const char *pText, int nText,
                           int (*xToken)(void *, int, const char *, int nToken,
                                         int iStart, int iEnd)) {
  int rc = SQLITE_OK;

  rc = tokenize_impl((void *)pTokenizer, pCtx, flags, pText, nText, xToken);

  return rc;
}

// -----------------------------------------------------------------------------

// entry point of c code
int register_xiaowei_tokenizers(sqlite3 *db, sqlite3_api_routines *pApi) {
  int rc = SQLITE_OK;

#ifndef SQLITE_CORE
  SQLITE_EXTENSION_INIT2(pApi);
#else
  UNUSED_PARAM(pApi);
#endif

  fts5_api *api = fts5_api_from_db(db);

  if (api == NULL) {
    return SQLITE_ERROR;
  }

  fts5_tokenizer tokenizer = {
      xiaoweiCreate,
      xiaoweiDelete,
      xiaoweiTokenize,
  };

  rc = api->xCreateTokenizer(api, "xiaowei", NULL, &tokenizer, NULL);

  return rc;
}
