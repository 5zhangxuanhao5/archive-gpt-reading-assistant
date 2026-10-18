import {get} from './db.js';
export async function rootHandle() { return (await get('root')) || null; }
