import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';

// Load your service account key JSON file
const KEYFILEPATH = path.join(process.cwd(), 'google.json');

// Your spreadsheet ID
const SPREADSHEET_ID = '143R7zuIZZuydFZTldj90auXpFI6bkvfMBJCPpIVcnqU';

// Scopes required to edit Google Sheets
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// Authorize with Google Sheets API
async function authorize() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
  });
  return await auth.getClient();
}

// Append a row with the given item data
export async function appendRowToSheet(item: {
  device: string;
  color: string;
  storage: string;
  carrier: string;
  quantity: number;
  price: number;
}) {
  const authClient = await authorize();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const values = [[
    item.device,
    item.color,
    item.storage,
    item.carrier,
    item.quantity,
    item.price,
  ]];

  const resource = { values };

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Sheet1!A:F', // Update to your actual sheet name and range
    valueInputOption: 'USER_ENTERED',
    resource,
  });

  return response.data;
}

// Example API handler for HTTP frameworks
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).send({ message: 'Only POST requests allowed' });
    return;
  }

  const item = req.body;

  try {
    const result = await appendRowToSheet(item);
    res.status(200).json({ message: 'Row appended successfully', data: result });
  } catch (error) {
    res.status(500).json({ message: 'Failed to append row', error });
  }
}
