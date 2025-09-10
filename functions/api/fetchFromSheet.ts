import { google } from 'googleapis';
import path from 'path';

const KEYFILEPATH = path.join(process.cwd(), 'google.json');
const SPREADSHEET_ID = '143R7zuIZZuydFZTldj90auXpFI6bkvfMBJCPpIVcnqU';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

async function authorize() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
  });
  return await auth.getClient();
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const authClient = await authorize();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:G', // Update to your actual range including timestamp column
    });

    const rows = response.data.values || [];
    const headers = rows.shift();
    if (!headers) {
      return res.status(404).json({ message: 'No data found' });
    }

    const data = rows.map(row => {
      const obj: Record<string, string | number> = {};
      headers.forEach((header: string, index: number) => {
        obj[header] = row[index] || '';
      });
      return obj;
    });

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to fetch sheet data', error });
  }
}
