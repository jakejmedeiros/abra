#!/usr/bin/env node

import * as ts from 'typescript';
import fs from 'fs';
import path from 'path';

function getTypeDefinitionFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (!["node_modules", "dist", "build"].some((exclude) => filePath.includes(exclude))) {
        getTypeDefinitionFiles(filePath, fileList);
      }
    } else if (file.endsWith(".ts") && filePath.includes("/src/")) {
      fileList.push(filePath);
    }
  });

  return fileList;
}

function createProgram(projectRoot) {
  const tsFiles = getTypeDefinitionFiles(projectRoot);
  console.log(`Found ${tsFiles.length} TypeScript files`);
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  
  let compilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true
  };
  
  if (fs.existsSync(tsconfigPath)) {
    console.log(`Using tsconfig at: ${tsconfigPath}`);
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      console.warn(`⚠️ Error reading tsconfig: ${configFile.error.messageText}`);
    } else {
      const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
      if (parsedConfig.errors.length) {
        console.warn(`⚠️ Errors parsing tsconfig: ${parsedConfig.errors.map(e => e.messageText).join(', ')}`);
      } else {
        compilerOptions = parsedConfig.options;
      }
    }
  } else {
    console.warn("⚠️ No tsconfig.json found. Using default settings.");
  }
  
  return ts.createProgram(tsFiles, compilerOptions);
}

function collectTypeDefinitions(program) {
  const typeChecker = program.getTypeChecker();
  const typeDefinitions = new Map();
  
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) {
      continue;
    }

    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isTypeAliasDeclaration(node) && 
          node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const typeName = node.name.text;
        const type = typeChecker.getTypeAtLocation(node.name);
        
        typeDefinitions.set(typeName, {
          name: typeName,
          type,
          declaration: node,
          sourceFile,
          file: sourceFile.fileName
        });
        console.log(`📝 Found type alias: ${typeName}`);
      }
      
      if (ts.isInterfaceDeclaration(node) && 
          node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const typeName = node.name.text;
        const type = typeChecker.getTypeAtLocation(node.name);
        
        typeDefinitions.set(typeName, {
          name: typeName,
          type,
          declaration: node,
          sourceFile,
          file: sourceFile.fileName
        });
        console.log(`📝 Found interface: ${typeName}`);
      }
      
      ts.forEachChild(node, visit);
    });
  }
  
  return typeDefinitions;
}

function generateActionsJson(projectRoot) {
  console.log(`✅ Project root is: ${projectRoot}`);
  console.log("🔍 Scanning project for @abra-action functions...");
  
  const program = createProgram(projectRoot);
  const typeChecker = program.getTypeChecker();
  
  console.log("📝 Collecting type definitions...");
  const typeDefinitions = collectTypeDefinitions(program);
  console.log(`📝 Found ${typeDefinitions.size} type definitions`);
  
  console.log("🔍 Processing type structures...");
  const typeRegistry = {};
  const processedTypes = new Set();
  
  for (const [typeName, typeInfo] of typeDefinitions) {
    if (!processedTypes.has(typeName)) {
      const typeStructure = serializeType(
        typeInfo.type, 
        typeChecker, 
        typeDefinitions,
        processedTypes,
        new Set()
      );
      
      typeRegistry[typeName] = {
        structure: typeStructure,
        file: typeInfo.file
      };
    }
  }
  
  console.log("🔍 Finding annotated functions...");
  const actions = [];
  
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) {
      continue;
    }
    
    ts.forEachChild(sourceFile, function visit(node) {
      if (ts.isFunctionDeclaration(node) && 
          node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) &&
          node.name) {
        
        const text = sourceFile.getFullText();
        const commentRanges = ts.getLeadingCommentRanges(text, node.pos);
        
        if (commentRanges && commentRanges.some(range => 
            text.substring(range.pos, range.end).includes('@abra-action'))) {
          
          const functionName = node.name.text;
          
          const commentText = commentRanges
            .map(range => text.substring(range.pos, range.end))
            .find(comment => comment.includes('@abra-action'));
          
          const description = commentText
            ?.replace('@abra-action', '')
            .replace(/\/\*|\*\/|\/\//g, '')
            .trim();
          
          const parameters = {};
          
          if (node.parameters) {
            node.parameters.forEach(param => {
              const paramName = param.name.getText(sourceFile);
              
              if (param.type) {
                const type = typeChecker.getTypeAtLocation(param);
                const typeName = param.type.getText(sourceFile);

                if (typeRegistry[typeName]) {
                  parameters[paramName] = typeRegistry[typeName].structure;
                } else {
                  parameters[paramName] = serializeType(
                    type, 
                    typeChecker, 
                    typeDefinitions,
                    processedTypes,
                    new Set()
                  );
                }
              } else {
                const type = typeChecker.getTypeAtLocation(param);
                parameters[paramName] = serializeType(
                  type, 
                  typeChecker, 
                  typeDefinitions,
                  processedTypes,
                  new Set()
                );
              }
            });
          }
          
          actions.push({
            name: functionName,
            description: description || `Execute ${functionName}`,
            parameters,
            module: sourceFile.fileName
          });
          
          console.log(`✅ Found action: ${functionName}`);
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  
  const actionsJson = { actions, typeAliases: typeRegistry };
  
  fs.writeFileSync(path.join(projectRoot, "actions.json"), JSON.stringify(actionsJson, null, 2));
  console.log("✅ actions.json generated successfully!");
}

function serializeType(type, typeChecker, typeDefinitions, processedTypes, visited) {
  if (!type) return "any";
  
  const typeId = type.id || (type.symbol && type.symbol.id) || Math.random().toString(36).substring(7);

  if (visited.has(typeId)) {
    return "any"; 
  }
  visited.add(typeId);
  
  if (type.flags & ts.TypeFlags.String) return "string";
  if (type.flags & ts.TypeFlags.Number) return "number";
  if (type.flags & ts.TypeFlags.Boolean) return "boolean";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) return "any";
  
  if (type.isLiteral && type.isLiteral()) {
    if (type.isStringLiteral && type.isStringLiteral()) return type.value;
    if (type.isNumberLiteral && type.isNumberLiteral()) return type.value;
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return type.intrinsicName === 'true'; 
    }
  }

  if (type.symbol && type.symbol.name && !isBuiltInType(type.symbol.name)) {
    const typeName = type.symbol.name;
    
    const typeInfo = Array.from(typeDefinitions.values()).find(t => 
      t.name === typeName && !isBuiltInType(typeName)
    );
    
    if (typeInfo && !processedTypes.has(typeName)) {
      processedTypes.add(typeName);
      
      if (typeInfo.type.getProperties) {
        const properties = typeInfo.type.getProperties();
        const structure = {};
        
        for (const prop of properties) {
          try {
            const propName = prop.getName();
            
            if (propName.startsWith('__') || isLikelyMethod(prop, typeChecker)) {
              continue;
            }
            
            const propType = prop.valueDeclaration 
              ? typeChecker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration)
              : typeChecker.getTypeOfSymbol(prop);
            
            structure[propName] = serializeType(
              propType, 
              typeChecker, 
              typeDefinitions, 
              processedTypes, 
              new Set(visited)
            );
          } catch (error) {
            console.warn(`⚠️ Error processing property: ${error.message}`);
          }
        }
        
        return structure;
      }
    }
  }

  if (type.isUnion && type.isUnion()) {
    const isAllStringLiterals = type.types.every(t => 
      t.isStringLiteral && t.isStringLiteral()
    );
    
    if (isAllStringLiterals) {
      return type.types.map(t => t.value);
    }
    
    const isBooleanUnion = type.types.length === 2 && 
      type.types.every(t => t.flags & ts.TypeFlags.BooleanLiteral);
    
    if (isBooleanUnion) {
      return "boolean";
    }

    const nonUndefinedType = type.types.find(t => 
      !(t.flags & ts.TypeFlags.Undefined) && !(t.flags & ts.TypeFlags.Null)
    );
    
    if (nonUndefinedType) {
      return serializeType(nonUndefinedType, typeChecker, typeDefinitions, processedTypes, new Set(visited));
    }
    
    return "any";
  }
  
  if (typeChecker.isArrayType(type)) {
    try {
      const elementType = typeChecker.getTypeArguments(type)[0];
      const serializedElementType = serializeType(
        elementType, 
        typeChecker, 
        typeDefinitions, 
        processedTypes, 
        new Set(visited)
      );
      
      return {
        type: 'array',
        items: serializedElementType
      };
    } catch (error) {
      console.warn(`⚠️ Error processing array type: ${error.message}`);
      return { type: 'array', items: 'any' };
    }
  }
  
  if (type.getProperties && typeof type.getProperties === 'function') {
    const properties = type.getProperties();
    
    if (properties.length) {
      const result = {};
      
      for (const prop of properties) {
        try {
          const propName = prop.getName();
          
          if (propName.startsWith('__') || isLikelyMethod(prop, typeChecker)) {
            continue;
          }
          
          const propType = prop.valueDeclaration 
            ? typeChecker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration)
            : typeChecker.getTypeOfSymbol(prop);
          
          result[propName] = serializeType(
            propType, 
            typeChecker, 
            typeDefinitions, 
            processedTypes, 
            new Set(visited)
          );
        } catch (error) {
          console.warn(`⚠️ Error processing property: ${error.message}`);
        }
      }
      
      return result;
    }
  }
  
  return typeChecker.typeToString(type);
}

function isBuiltInType(typeName) {
  const builtInTypes = [
    'Array', 'String', 'Number', 'Boolean', 'Object', 'Function',
    'Promise', 'Date', 'RegExp', 'Error', 'Map', 'Set', 'Symbol',
    'Iterator', 'Generator'
  ];
  
  return builtInTypes.includes(typeName) || typeName === '__type';
}

function isLikelyMethod(symbol, typeChecker) {
  if (!symbol.valueDeclaration) return false;
  
  const symbolType = typeChecker.getTypeOfSymbol(symbol);
  if (!symbolType) return false;
  
  return symbolType.getCallSignatures && 
         symbolType.getCallSignatures().length > 0;
}

const projectRoot = process.argv[2] || process.cwd();
generateActionsJson(projectRoot);