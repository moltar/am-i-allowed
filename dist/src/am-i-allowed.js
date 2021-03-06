"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Role = exports.PrivilegeManager = void 0;
const types_1 = require("./types");
const permission_checker_1 = require("./permission-checker");
const operations_taxonomy_1 = require("./operations-taxonomy");
/**
 * This is the main class. Normally you'd need just one PrivilegeManager for the whole application.
 * Use it to check permissions.
 *
 * * Special terms:
 *
 * The relation between ac actor to a given entity may be one of the following:
 * - Visitor: a not logged-in user
 * - User: a logged-in user, with an account
 * - Group Member: a user that shares the group of the entity
 * - a role owner: there's a role explicitly assigned to the use on the entity
 *
 */
class PrivilegeManager {
    /**
     * Builds a privilege manager instance.
     * @param store the persistence backend for the permission storage
     * @param operationsTransformer an optional operation tree transformer, in case you wish to alter the default one, add more operations, etc
     */
    constructor(store, operationsTransformer = (operationTree) => operationTree) {
        this.store = store;
        this.operationTree = new OperationTree(operationsTransformer(operations_taxonomy_1.DefaultOperationsTaxonomy));
        this.entityMetaDataLookup = new EntityMetaDataLookup(this);
    }
    /**
     * Check for if the actor is allowed to do something and throws an exception if he isn't
     * @param actor
     * @param operation
     * @param entity
     * @param specialContext for custom logic
     */
    async test(actor, operation, entity, specialContext) {
        // @ts-ignore
        const isAllowed = await checkPermissionSoft(...arguments);
        if (!isAllowed) { // @ts-ignore
            throw new NoPrivilegeException(...arguments);
        }
    }
    /**
     * Check if the actor is allowed to do
     * @param actor
     * @param operation
     * @param entity
     * @param specialContext
     */
    isAllowed(actor, operation, entity, specialContext) {
        if (!this.operationTree.find(operation))
            throw new Error(`Operation ${operation.toString()} is not defined. Consider adding it to the operations tree.`);
        if (entity.customPermissionChecker)
            // @ts-ignore
            return entity.customPermissionChecker(this, ...arguments);
        // @ts-ignore
        return permission_checker_1.standardPermissionChecker(this, ...arguments);
    }
    /**
     * assign a role to use in entity
     * @param entity the entity
     * @param actor either IActor or an id
     * @param role the role
     */
    assignRole(entity, actor, role) {
        return this.store.assignRole(entity.id, actor?.id || actor, role.roleName);
    }
    async getRolesForUserId(id, entity) {
        return this.store.getRolesForUser(id, entity, await this.findMetaData(entity));
    }
    /**
     * Define a new role. Also add itself to the corresponding entityType
     * @param roleName name of role
     * @param entityTypes The entity types this role is applicable to
     * @param operations the operation the role holder may do on the entities of the aforementioned types
     */
    addRole(roleName, operations, ...entityTypes) {
        return new Role(this, roleName, operations, ...entityTypes);
    }
    deleteRole(roleName, entityTypeName) {
        return this.store.deleteRole(roleName, entityTypeName);
    }
    async saveRole(entityTypeName, role) {
        await this.store.saveRole(entityTypeName, role);
    }
    getOrAddMetaData(type) {
        return this.entityMetaDataLookup.getOrAddMetaData(type);
    }
    async findMetaData(entity) {
        return this.entityMetaDataLookup.findMetaData(entity);
    }
}
exports.PrivilegeManager = PrivilegeManager;
class NoPrivilegeException extends Error {
    constructor(actor, operation, entity, specialContext) {
        super(`${actor.id} attempted unprivileged operation ${operation.toString()} on ${entity.id} with ${JSON.stringify(specialContext || '')}`);
    }
}
////////////////////////////////////////////
/**
 * This class's purpose is to holds the operation definition tree and provide the expandOperation method
 */
class OperationTree {
    constructor(tree) {
        this.tree = tree;
        this.parentsMap = new Map();
        this.processTree(tree);
    }
    processTree(tree) {
        const self = this;
        populate(tree);
        function populate(node, parents = []) {
            for (let [name, children] of Object.entries(node)) {
                const entryParents = self.parentsMap.get(name) || [];
                self.parentsMap.set(name, entryParents.concat(parents));
                children && Object.keys(children).length && populate(children, [name, ...parents]);
            }
        }
    }
    /**
     * expand to include the super-operations
     * @param operation
     */
    expandOperation(operation) {
        if (!operation)
            return [];
        const parents = this.parentsMap.get(operation);
        if (parents.length)
            return [operation, ...parents];
        return [operation, ...parents,
            ...parents.reduce((a, c) => {
                a.push(...this.expandOperation(c));
                return a;
            }, [])];
    }
    find(operation) {
        return this.parentsMap.has(operation);
    }
}
class EntityMetaDataLookup {
    constructor(privilegeManager) {
        this.privilegeManager = privilegeManager;
        this.metaDataMap = new Map();
    }
    getOrAddMetaData(entityType) {
        const name = typeof entityType == 'string' ? entityType : entityType.name;
        const clazz = typeof entityType == 'string' ? null : entityType;
        let metadata = this.metaDataMap.get(name);
        if (!metadata) {
            // @ts-ignore
            metadata = clazz?.permissionsMetaData || new types_1.PermissionsMetaData(name, {});
            this.metaDataMap.set(name, metadata);
        }
        return metadata;
    }
    async findMetaData(entity) {
        let permissionsMetaDataOnEntity = entity.permissionsMetaData;
        permissionsMetaDataOnEntity = typeof permissionsMetaDataOnEntity == "function" ? await permissionsMetaDataOnEntity() : permissionsMetaDataOnEntity;
        permissionsMetaDataOnEntity && (permissionsMetaDataOnEntity._validated ?? (permissionsMetaDataOnEntity._validated = this.validateMetaData(permissionsMetaDataOnEntity)));
        return permissionsMetaDataOnEntity || this.getOrAddMetaData(entity.constructor == Object ? entity.___name : entity.constructor.name);
    }
    validateMetaData(md) {
        [...md.defaultGroupMemberPermissions, ...md.defaultUserPermissions, ...md.defaultVisitorPermissions].forEach(o => {
            if (!this.privilegeManager.operationTree.find(o))
                throw new Error('Operation "${o}" is not in the taxonomy');
        });
        return true;
    }
}
/**
 * Role defines the set of permitted operations. Each role is applicable to a provided entity types
 */
class Role {
    constructor(pm, roleName, operations, ...entityTypes) {
        this.roleName = roleName;
        this.operations = new Set(operations);
        [...entityTypes].forEach(type => {
            const metaData = pm.getOrAddMetaData(type);
            metaData.roles[this.roleName] = this;
            pm.saveRole(metaData.name, this);
        });
    }
}
exports.Role = Role;
//# sourceMappingURL=am-i-allowed.js.map