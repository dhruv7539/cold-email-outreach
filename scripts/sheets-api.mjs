import { getAccessToken } from "./gmail-api.mjs";
import { getDefaultSheetsOauthPaths } from "./google-oauth.mjs";

export async function getSheetsAccessToken(overrides = {}) {
  const { oauthPath, credentialsPath } = getDefaultSheetsOauthPaths(overrides);
  const accessToken = await getAccessToken(oauthPath, credentialsPath);
  return { accessToken, oauthPath, credentialsPath };
}

async function sheetsApiRequest(accessToken, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`https://sheets.googleapis.com/v4/${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Sheets API request failed: ${response.status} ${await response.text()}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export async function getSheetValues(accessToken, spreadsheetId, range) {
  return sheetsApiRequest(
    accessToken,
    `spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
  );
}

export async function updateSheetValues(
  accessToken,
  spreadsheetId,
  range,
  values,
  valueInputOption = "USER_ENTERED"
) {
  const query = new URLSearchParams({ valueInputOption });
  return sheetsApiRequest(
    accessToken,
    `spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${query.toString()}`,
    {
      method: "PUT",
      body: {
        range,
        majorDimension: "ROWS",
        values,
      },
    }
  );
}

export async function appendSheetValues(
  accessToken,
  spreadsheetId,
  range,
  values,
  valueInputOption = "USER_ENTERED",
  insertDataOption = "INSERT_ROWS"
) {
  const query = new URLSearchParams({ valueInputOption, insertDataOption });
  return sheetsApiRequest(
    accessToken,
    `spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${query.toString()}`,
    {
      method: "POST",
      body: {
        range,
        majorDimension: "ROWS",
        values,
      },
    }
  );
}

export async function batchUpdateSheetValues(
  accessToken,
  spreadsheetId,
  data,
  valueInputOption = "USER_ENTERED"
) {
  return sheetsApiRequest(
    accessToken,
    `spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    {
      method: "POST",
      body: {
        valueInputOption,
        data,
      },
    }
  );
}

export async function clearSheetRange(accessToken, spreadsheetId, range) {
  return sheetsApiRequest(
    accessToken,
    `spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
    {
      method: "POST",
      body: {},
    }
  );
}

