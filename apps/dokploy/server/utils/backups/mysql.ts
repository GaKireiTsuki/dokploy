import { unlink } from "node:fs/promises";
import path from "node:path";
import type { BackupSchedule } from "@/server/api/services/backup";
import type { MySql } from "@/server/api/services/mysql";
import { findProjectById } from "@/server/api/services/project";
import {
	getRemoteServiceContainer,
	getServiceContainer,
} from "../docker/utils";
import { sendDatabaseBackupNotifications } from "../notifications/database-backup";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { getS3Credentials } from "./utils";

export const runMySqlBackup = async (mysql: MySql, backup: BackupSchedule) => {
	const { appName, databaseRootPassword, projectId, name } = mysql;
	const project = await findProjectById(projectId);
	const { prefix, database } = backup;
	const destination = backup.destination;
	const backupFileName = `${new Date().toISOString()}.sql.gz`;
	const bucketDestination = path.join(prefix, backupFileName);

	try {
		const rcloneFlags = getS3Credentials(destination);
		const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;

		const rcloneCommand = `rclone rcat ${rcloneFlags.join(" ")} "${rcloneDestination}"`;
		if (mysql.serverId) {
			const { Id: containerId } = await getRemoteServiceContainer(
				mysql.serverId,
				appName,
			);
			const mysqlDumpCommand = `docker exec ${containerId} sh -c "mysqldump --default-character-set=utf8mb4 -u 'root' --password='${databaseRootPassword}' --single-transaction --no-tablespaces --quick '${database}' | gzip"`;

			await execAsyncRemote(
				mysql.serverId,
				`${mysqlDumpCommand} | ${rcloneCommand}`,
			);
		} else {
			const { Id: containerId } = await getServiceContainer(appName);
			const mysqlDumpCommand = `docker exec ${containerId} sh -c "mysqldump --default-character-set=utf8mb4 -u 'root' --password='${databaseRootPassword}' --single-transaction --no-tablespaces --quick '${database}' | gzip"`;

			await execAsync(`${mysqlDumpCommand} | ${rcloneCommand}`);
		}
		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: "mysql",
			type: "success",
		});
	} catch (error) {
		console.log(error);
		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: "mysql",
			type: "error",
			// @ts-ignore
			errorMessage: error?.message || "Error message not provided",
		});
		throw error;
	}
};
